import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INTERNAL_HEADER,
  PLATFORM_HEALTH_PATH,
  PLATFORM_SCHEDULED_PATH,
  SIGNED_CALL_HEADERS,
  SIGNED_CALL_MAX_SKEW_MS,
  TENANT_CALL_PATHS,
  deriveCallKeys,
  generateHandoffKeyPair,
  generatePlatformCallSecret,
  signRequest,
  signResponse,
  verifySignedRequest,
  verifySignedResponse,
  type CallKeys,
  type PlatformCapability,
  type ScheduledRunSummary,
  type TenantInfoAnswer,
  type TenantProps,
} from "../../src/shared/hosted-contract";
import { createApp } from "../src/app";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import { buildTenantProps, callTenant, newCallId, platformRequest } from "../src/dispatch";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey, openCallSecret, sealCallSecret } from "../src/keys";
import { removeTenant, requestTenant, runProvisioning, type ProvisioningDeps } from "../src/provisioning";
import { enqueueDue, handleScheduleBatch, type ScheduleMessage } from "../src/scheduling";
import { HttpsTenantDispatcher, RuntimeDispatcher, clearCallKeyCache } from "../src/starter";
import { moveTenantToDispatch } from "../src/tenant-move";
import { clearTenantCache, type TenantRecord } from "../src/tenants";
import { FakeCloudflareApi, type FakeScript } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing, type FakeOpenPingState } from "./fake-openping";

/**
 * Starter mode on the platform (docs/hosted/CONTRACT.md, section 10): each
 * customer an ordinary Worker reached at its own Custom Domain, called over
 * HTTPS signed with its own secret. The "network" below routes a fetch to a
 * hostname's Custom Domain, then to that Worker, which verifies exactly as a
 * starter tenant does (the contract's helpers, its own secret from its own
 * binding, each nonce once) before answering like OpenPing and signing the
 * answer. Tenant to platform goes through the real app's /__tenant/v1/ routes.
 */

const DOMAIN = "openping.example";
const ZONE = "0123456789abcdef0123456789abcdef";
const PLATFORM_KEY = generateMasterKey();
let HANDOFF_PUBLIC_KEY = "";

const text = (s: string) => new Uint8Array(new TextEncoder().encode(s));
const BUNDLE: TenantBundle = {
  version: "0.18.0",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default {}", contentType: "application/javascript+module" }],
  assets: [{ path: "/index.html", content: text("<!doctype html><title>OpenPing</title>"), contentType: "text/html" }],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: ["nodejs_compat"],
  assetsConfig: {},
  vars: { WORKERS_PLAN: "paid" },
  durableObjects: [{ name: "REGION_PROBE", className: "RegionProbe" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["RegionProbe"] }],
  d1Migrations: [],
};

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

/** One starter tenant's Worker as the network sees it: what it verified, and its fake OpenPing. */
interface StarterWorker {
  script: FakeScript;
  state: FakeOpenPingState;
  nonces: Set<string>;
  refused: string[];
  props: TenantProps[];
}

interface World {
  api: FakeCloudflareApi;
  namespace: FakeDispatcher;
  deps: ProvisioningDeps;
  workers: Map<string, StarterWorker>;
  clock: { now: number };
  /** Every request the platform sent out, as sent. */
  sent: Request[];
  /** Make the network answer this instead of the tenant (a forged answer). */
  intercept?: (request: Request) => Response | null;
}

function secretOf(script: FakeScript): string {
  const binding = script.metadata.bindings.find((b) => b.name === "PLATFORM_CALL_SECRET");
  if (!binding || binding.type !== "secret_text") throw new Error("no PLATFORM_CALL_SECRET binding");
  return binding.text;
}

function world(): World {
  const api = new FakeCloudflareApi();
  const namespace = new FakeDispatcher();
  const workers = new Map<string, StarterWorker>();
  const clock = { now: Date.now() };
  const sent: Request[] = [];
  api.onScriptChange = (name, script) => {
    if (!script) {
      // One name, two places: only the one that is gone stops answering.
      if (!api.scriptIn(null, name)) workers.delete(name);
      if (![...api.scripts.values()].some((s) => s.namespace !== null && s.metadata.tags?.includes(`tenant-${name.slice(2)}`))) namespace.remove(name);
      return;
    }
    if (script.namespace === null) {
      const previous = workers.get(name);
      workers.set(name, { script, state: fakeOpenPing(script, { state: previous?.state }).state, nonces: previous?.nonces ?? new Set(), refused: [], props: [] });
    } else {
      namespace.register(name, fakeOpenPing(script, { healthMigrates: true }).worker);
    }
  };
  const w: World = { api, namespace, workers, clock, sent, deps: undefined as unknown as ProvisioningDeps };

  /** The network: a hostname's Custom Domain, then its Worker, which verifies before anything else. */
  const network = async (request: Request): Promise<Response> => {
    sent.push(request.clone());
    const forged = w.intercept?.(request);
    if (forged) return forged;
    const domain = api.customDomainAt(new URL(request.url).hostname);
    const worker = domain ? workers.get(domain.service) : undefined;
    if (!worker) return new Response("error code: 1016", { status: 530 });
    const keys = await deriveCallKeys(secretOf(worker.script));
    const tenantId = worker.state.env.TENANT_ID!;
    const verified = await verifySignedRequest(request, { direction: "platform-to-tenant", now: clock.now, keysFor: async (id) => (id === tenantId ? keys : null) });
    if (!verified.ok || !verified.props || worker.nonces.has(verified.nonce)) {
      worker.refused.push(verified.ok ? "replayed" : verified.error);
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    worker.nonces.add(verified.nonce);
    const props: TenantProps = { ...verified.props, platform: noopPlatform };
    worker.props.push(props);
    const answer = await fakeOpenPing(worker.script, { state: worker.state }).worker(verified.request, props);
    return signResponse({ status: answer.status, body: await answer.text() }, { requestDirection: "platform-to-tenant", tenantId, requestNonce: verified.nonce, keys });
  };

  const https = new HttpsTenantDispatcher({ db: env.PLATFORM_DB, platformKey: PLATFORM_KEY, fetch: (r) => network(r as Request), now: () => clock.now });
  w.deps = {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher: new RuntimeDispatcher({ dispatch: namespace, starter: https }),
    capability: () => noopPlatform,
    config: {
      hostedDomain: DOMAIN,
      namespace: "",
      platformKey: PLATFORM_KEY,
      handoffPublicKey: HANDOFF_PUBLIC_KEY,
      mode: "starter",
      addresses: { kind: "custom_domains", zoneId: ZONE, dispatchService: "openping-platform" },
    },
    now: () => clock.now,
  };
  return w;
}

let seq = 0;
async function starterTenant(w: World, slug: string): Promise<string> {
  seq++;
  const accountId = `acc_starter${seq}`;
  await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(accountId, `starter${seq}@example.com`).run();
  const result = await requestTenant(env.PLATFORM_DB, { accountId, slug, now: w.clock.now, runtime: "starter" });
  if (!result.ok) throw new Error(result.reason);
  expect(await runProvisioning(w.deps, result.tenantId, { force: true })).toEqual({ kind: "ready", tenantId: result.tenantId });
  return result.tenantId;
}

async function record(id: string): Promise<TenantRecord> {
  const { findTenantBySlug } = await import("../src/tenants");
  const slug = (await env.PLATFORM_DB.prepare("SELECT slug FROM tenants WHERE id = ?").bind(id).first<{ slug: string }>())!.slug;
  return (await findTenantBySlug(env.PLATFORM_DB, slug))!;
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  HANDOFF_PUBLIC_KEY = (await generateHandoffKeyPair()).publicKey;
});

beforeEach(() => {
  clearCallKeyCache();
  clearTenantCache();
});

describe("provisioning a starter tenant", () => {
  it("makes an ordinary Worker with its own secret, reached only at its own Custom Domain, migrated over signed calls", async () => {
    const w = world();
    const id = await starterTenant(w, "starterco");
    const script = w.api.scriptIn(null, `t-${id}`)!;
    expect(script).toBeTruthy();
    expect(w.api.scriptIn("", `t-${id}`)).toBeUndefined();
    const vars = Object.fromEntries(script.metadata.bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, (b as { text: string }).text]));
    expect(vars).toMatchObject({ HOSTED_MODE: "1", TENANT_ID: id, HOSTED_TRANSPORT: "https", PLATFORM_URL: `https://app.${DOMAIN}` });
    // The secret is a secret binding, never a var.
    expect(script.metadata.bindings.find((b) => b.name === "PLATFORM_CALL_SECRET")?.type).toBe("secret_text");
    expect(Object.keys(vars)).not.toContain("PLATFORM_CALL_SECRET");
    expect(script.workersDev).toBe(false);
    expect(w.api.customDomainAt(`starterco.${DOMAIN}`)).toMatchObject({ service: `t-${id}`, zoneId: ZONE });
    // Migrated and checked by signed platform calls, each with platform props for this tenant.
    const worker = w.workers.get(`t-${id}`)!;
    expect(worker.state.scheduledRuns).toHaveLength(1);
    expect(worker.props.length).toBeGreaterThanOrEqual(2);
    for (const p of worker.props) expect(p).toMatchObject({ invocation: "platform", tenant: { id, slug: "starterco" } });
    expect(worker.refused).toEqual([]);
    expect(w.namespace.calls).toEqual([]);
  });

  it("gives every tenant its own secret, stored sealed and never in the clear", async () => {
    const w = world();
    const a = await starterTenant(w, "secret-a");
    const b = await starterTenant(w, "secret-b");
    const secretA = secretOf(w.api.scriptIn(null, `t-${a}`)!);
    const secretB = secretOf(w.api.scriptIn(null, `t-${b}`)!);
    expect(secretA).not.toBe(secretB);
    const rows = await env.PLATFORM_DB.prepare("SELECT tenant_id, ciphertext FROM tenant_call_secrets WHERE tenant_id IN (?, ?)").bind(a, b).all<{ tenant_id: string; ciphertext: string }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.ciphertext).not.toContain(secretA);
      expect(row.ciphertext).not.toContain(secretB);
    }
    // Sealed to its tenant: another tenant's row doesn't open as this one's.
    const rowA = rows.results.find((r) => r.tenant_id === a)!;
    expect(await openCallSecret(rowA.ciphertext, a, PLATFORM_KEY)).toBe(secretA);
    await expect(openCallSecret(rowA.ciphertext, b, PLATFORM_KEY)).rejects.toThrow(/does not decrypt/);
    await expect(openCallSecret(await sealCallSecret(secretA, a, generateMasterKey()), a, PLATFORM_KEY)).rejects.toThrow();
    // No request the platform sent carries a secret.
    for (const request of w.sent) {
      const all = `${[...request.headers].join("\n")}\n${await request.text()}`;
      expect(all).not.toContain(secretA);
      expect(all).not.toContain(secretB);
    }
  });

  it("detaches the address, deletes the Worker and forgets the secret on removal", async () => {
    const w = world();
    const id = await starterTenant(w, "goneco");
    expect(await removeTenant(w.deps, id)).toEqual({ kind: "removed", tenantId: id });
    expect(w.api.customDomainAt(`goneco.${DOMAIN}`)).toBeUndefined();
    expect(w.api.scriptIn(null, `t-${id}`)).toBeUndefined();
    expect((await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM tenant_call_secrets WHERE tenant_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("the platform's calls to a starter tenant", () => {
  const call = (w: World, tenant: TenantRecord, path = PLATFORM_HEALTH_PATH, body?: unknown) =>
    callTenant(w.deps.dispatcher, { tenant, hostedDomain: DOMAIN, platform: noopPlatform }, path, body === undefined ? {} : { method: "POST", body });

  it("run the scheduler from the queue consumer, over HTTPS", async () => {
    const w = world();
    const id = await starterTenant(w, "queueco");
    const sent: ScheduleMessage[] = [];
    const queue = { send: async (m: ScheduleMessage) => void sent.push(m), sendBatch: async (ms: { body: ScheduleMessage }[]) => void sent.push(...ms.map((m) => m.body)) } as unknown as Queue<ScheduleMessage>;
    await enqueueDue({ db: env.PLATFORM_DB, now: () => w.clock.now }, queue, w.clock.now);
    const mine = sent.filter((m) => m.tenantId === id);
    expect(mine).toHaveLength(1);
    const acks: string[] = [];
    const batch = {
      queue: "openping-schedule",
      messages: mine.map((body, i) => ({ id: `m${i}`, attempts: 1, body, timestamp: new Date(), ack: () => acks.push(body.tenantId), retry: () => {} })),
    } as unknown as MessageBatch<unknown>;
    const before = w.workers.get(`t-${id}`)!.state.scheduledRuns.length;
    const results = await handleScheduleBatch({ db: env.PLATFORM_DB, dispatcher: w.deps.dispatcher, capability: () => noopPlatform, hostedDomain: DOMAIN, now: () => w.clock.now }, batch);
    expect(acks).toEqual([id]);
    expect(results[0]).toMatchObject({ tenantId: id });
    expect(w.workers.get(`t-${id}`)!.state.scheduledRuns.length).toBe(before + 1);
  });

  it("treat an answer that isn't signed for the call as no answer", async () => {
    const w = world();
    const id = await starterTenant(w, "forgedanswerco");
    const tenant = await record(id);
    // Someone between the two answers in the tenant's place.
    w.intercept = () => Response.json({ ok: true, version: "0.18.0", schemaVersion: 99, bundledSchemaVersion: 19, migrating: false, lastRun: null });
    await expect(call(w, tenant)).rejects.toThrow(/isn't signed for this call/);
    // ...or replays a real answer from an earlier call.
    w.intercept = undefined;
    const real = await call(w, tenant);
    expect(real.kind).toBe("response");
    const earlier = w.sent.at(-1)!;
    const keys = await deriveCallKeys(secretOf(w.api.scriptIn(null, `t-${id}`)!));
    const replayedAnswer = await signResponse({ status: 200, body: "{}" }, { requestDirection: "platform-to-tenant", tenantId: id, requestNonce: earlier.headers.get(SIGNED_CALL_HEADERS.nonce)!, keys });
    w.intercept = () => replayedAnswer.clone();
    await expect(call(w, tenant)).rejects.toThrow(/isn't signed for this call/);
  });

  it("are refused by the tenant when replayed, expired or signed with another tenant's secret", async () => {
    const w = world();
    const a = await starterTenant(w, "victimco");
    const b = await starterTenant(w, "otherco");
    const worker = w.workers.get(`t-${a}`)!;
    // A captured call, sent again.
    const captured = w.sent.filter((r) => new URL(r.url).hostname === `victimco.${DOMAIN}`).at(-1)!;
    expect((await (await fetchVia(w, captured.clone())).json())).toEqual({ error: "not_found" });
    expect(worker.refused.at(-1)).toBe("replayed");
    // Tenant B's secret, signing a call for A.
    const tenantA = await record(a);
    const keysB = await deriveCallKeys(secretOf(w.api.scriptIn(null, `t-${b}`)!));
    const props = buildTenantProps({ tenant: tenantA, hostedDomain: DOMAIN, invocation: "platform", callId: newCallId(), platform: noopPlatform });
    const { platform: _p, ...carried } = props;
    const forged = await signRequest(
      { method: "GET", url: platformRequest(tenantA, DOMAIN, PLATFORM_HEALTH_PATH, props.callId).url },
      { direction: "platform-to-tenant", tenantId: a, keys: keysB, now: w.clock.now, props: carried },
    );
    expect((await fetchVia(w, forged)).status).toBe(404);
    expect(worker.refused.at(-1)).toBe("bad_signature");
    // A's own call, kept too long.
    const keysA = await deriveCallKeys(secretOf(w.api.scriptIn(null, `t-${a}`)!));
    const stale = await signRequest(
      { method: "GET", url: `https://victimco.${DOMAIN}${PLATFORM_HEALTH_PATH}` },
      { direction: "platform-to-tenant", tenantId: a, keys: keysA, now: w.clock.now - SIGNED_CALL_MAX_SKEW_MS - 1, props: { ...carried, callId: newCallId() } },
    );
    expect((await fetchVia(w, stale)).status).toBe(404);
    expect(worker.refused.at(-1)).toBe("expired");
  });

  it("never relay a visitor's request", async () => {
    const w = world();
    const id = await starterTenant(w, "publicco");
    const tenant = await record(id);
    const props = buildTenantProps({ tenant, hostedDomain: DOMAIN, invocation: "public", callId: newCallId(), platform: noopPlatform });
    await expect(w.deps.dispatcher.dispatch(tenant, new Request(`https://publicco.${DOMAIN}/`), props, { cpuMs: 1, subRequests: 1 })).rejects.toThrow(/never relays/);
  });

  it("fail clearly for a runtime the platform isn't configured for", async () => {
    const dispatcher = new RuntimeDispatcher({ dispatch: null, starter: null });
    const tenant = { scriptName: "t-x", runtime: "dispatch" as const };
    await expect(dispatcher.dispatch(tenant, new Request("https://x/"), {} as TenantProps, { cpuMs: 1, subRequests: 1 })).rejects.toThrow(/isn't configured/);
  });
});

/** Sends a request through the world's network (as an attacker on the internet could). */
async function fetchVia(w: World, request: Request): Promise<Response> {
  const https = (w.deps.dispatcher as unknown as { by: { starter: HttpsTenantDispatcher } }).by.starter;
  const send = (https as unknown as { deps: { fetch: (r: Request) => Promise<Response> } }).deps.fetch;
  return send(request);
}

describe("a starter tenant's calls to the platform", () => {
  const app = createApp({ dispatcher: () => new FakeDispatcher(), capability: () => noopPlatform });
  const platformEnv = (): PlatformEnv => ({ ...(env as unknown as PlatformEnv), HOSTED_DOMAIN: DOMAIN, PLATFORM_KEY });

  async function tenantCall(path: string, body: unknown, sign: { tenantId: string; keys: CallKeys; now?: number }) {
    const request = await signRequest(
      { method: "POST", url: `https://app.${DOMAIN}${path}`, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      { direction: "tenant-to-platform", tenantId: sign.tenantId, keys: sign.keys, now: sign.now ?? Date.now() },
    );
    return { request, response: await send(request.clone()) };
  }

  async function send(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await app.fetch(request, platformEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function keysOf(w: World, id: string) {
    return deriveCallKeys(secretOf(w.api.scriptIn(null, `t-${id}`)!));
  }

  it("get the tenant's description, signed for that call, and record usage and audit events for the signer only", async () => {
    const w = world();
    const id = await starterTenant(w, "callerco");
    const keys = await keysOf(w, id);
    const { request, response } = await tenantCall(TENANT_CALL_PATHS.info, {}, { tenantId: id, keys });
    const verified = await verifySignedResponse(response, { requestDirection: "tenant-to-platform", tenantId: id, requestNonce: request.headers.get(SIGNED_CALL_HEADERS.nonce)!, keys });
    expect(verified?.status).toBe(200);
    const info = JSON.parse(verified!.text) as TenantInfoAnswer;
    expect(info).toMatchObject({ contract: 1, tenant: { id, slug: "callerco", status: "trial", plan: "trial" } });

    const at = Date.now();
    expect((await tenantCall(TENANT_CALL_PATHS.reportUsage, { monitors: 3, statusPages: 1, channels: 2, at }, { tenantId: id, keys })).response.status).toBe(200);
    const usage = await env.PLATFORM_DB.prepare("SELECT monitors FROM tenant_usage WHERE tenant_id = ?").bind(id).first<{ monitors: number }>();
    expect(usage?.monitors).toBe(3);
    expect((await tenantCall(TENANT_CALL_PATHS.audit, { action: "session.created", actor: "customer", at }, { tenantId: id, keys })).response.status).toBe(200);
    expect((await env.PLATFORM_DB.prepare("SELECT tenant_id FROM audit_events WHERE action = 'session.created' ORDER BY id DESC LIMIT 1").first<{ tenant_id: string }>())?.tenant_id).toBe(id);
  });

  it("refuse, as an unknown path, a forged, replayed, expired, cross-tenant or unsigned call", async () => {
    const w = world();
    const a = await starterTenant(w, "honestco");
    const b = await starterTenant(w, "impostorco");
    const keysA = await keysOf(w, a);
    const keysB = await keysOf(w, b);
    const usage = { monitors: 999, statusPages: 1, channels: 0, at: Date.now() };
    const cases: [string, Promise<Response>][] = [
      // Tenant B's secret, claiming to be A.
      ["cross-tenant", tenantCall(TENANT_CALL_PATHS.reportUsage, usage, { tenantId: a, keys: keysB }).then((r) => r.response)],
      ["forged", tenantCall(TENANT_CALL_PATHS.reportUsage, usage, { tenantId: a, keys: await deriveCallKeys(generatePlatformCallSecret()) }).then((r) => r.response)],
      ["expired", tenantCall(TENANT_CALL_PATHS.reportUsage, usage, { tenantId: a, keys: keysA, now: Date.now() - SIGNED_CALL_MAX_SKEW_MS - 1_000 }).then((r) => r.response)],
      ["unsigned", send(new Request(`https://app.${DOMAIN}${TENANT_CALL_PATHS.reportUsage}`, { method: "POST", headers: { [SIGNED_CALL_HEADERS.tenant]: a, [INTERNAL_HEADER]: "x" }, body: JSON.stringify(usage) }))],
      ["unknown path", tenantCall("/__tenant/v1/delete-everything", {}, { tenantId: a, keys: keysA }).then((r) => r.response)],
    ];
    for (const [what, pending] of cases) {
      const response = await pending;
      expect(response.status, what).toBe(404);
      expect(response.headers.has(SIGNED_CALL_HEADERS.signature), what).toBe(false);
    }
    const { request, response } = await tenantCall(TENANT_CALL_PATHS.reportUsage, { ...usage, monitors: 4 }, { tenantId: a, keys: keysA });
    expect(response.status).toBe(200);
    expect((await send(request.clone())).status).toBe(404);
    const row = await env.PLATFORM_DB.prepare("SELECT monitors FROM tenant_usage WHERE tenant_id = ?").bind(a).first<{ monitors: number }>();
    expect(row?.monitors).toBe(4);
  });

  it("tells a tenant that isn't ready so, and a dispatch tenant has no secret to sign with", async () => {
    const w = world();
    const id = await starterTenant(w, "notreadyco");
    const keys = await keysOf(w, id);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_state = 'migrated' WHERE id = ?").bind(id).run();
    const { request, response } = await tenantCall(TENANT_CALL_PATHS.info, {}, { tenantId: id, keys });
    const verified = await verifySignedResponse(response, { requestDirection: "tenant-to-platform", tenantId: id, requestNonce: request.headers.get(SIGNED_CALL_HEADERS.nonce)!, keys });
    expect(verified).toEqual({ status: 409, text: JSON.stringify({ error: "tenant_not_ready" }) });
  });
});

describe("moving a starter tenant to Workers for Platforms", () => {
  it("uploads it into the namespace, checks it there, re-points its address, and deletes the starter Worker", async () => {
    const w = world();
    const id = await starterTenant(w, "moverco");
    w.deps.config = { ...w.deps.config, namespace: "openping-tenants" };
    const outcome = await moveTenantToDispatch(w.deps, id);
    expect(outcome).toEqual({ kind: "moved", tenantId: id, version: "0.18.0" });
    const moved = await record(id);
    expect(moved.runtime).toBe("dispatch");
    const script = w.api.scriptIn("openping-tenants", `t-${id}`)!;
    const names = script.metadata.bindings.map((b) => b.name);
    expect(names).not.toContain("HOSTED_TRANSPORT");
    expect(names).not.toContain("PLATFORM_CALL_SECRET");
    expect(w.api.scriptIn(null, `t-${id}`)).toBeUndefined();
    expect(w.api.customDomainAt(`moverco.${DOMAIN}`)).toMatchObject({ service: "openping-platform" });
    expect((await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM tenant_call_secrets WHERE tenant_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
    // The platform now calls it through the namespace, with props.
    const result = await callTenant(w.deps.dispatcher, { tenant: moved, hostedDomain: DOMAIN, platform: noopPlatform }, PLATFORM_SCHEDULED_PATH, {
      method: "POST",
      body: { runId: "after-move", scheduledTime: w.clock.now, cron: "* * * * *" },
    });
    expect(result.kind === "response" && ((await result.response.json()) as ScheduledRunSummary).runId).toBe("after-move");
    expect(w.namespace.calls.at(-1)?.props.invocation).toBe("platform");
  });

  it("changes nothing when the new Worker isn't healthy, and is refused without a namespace", async () => {
    const w = world();
    const id = await starterTenant(w, "stayco");
    expect(await moveTenantToDispatch(w.deps, id)).toMatchObject({ kind: "refused" });
    w.deps.config = { ...w.deps.config, namespace: "openping-tenants" };
    w.api.onScriptChange = (name, script) => {
      if (script && script.namespace !== null) w.namespace.register(name, async () => Response.json({ ok: false }, { status: 503 }));
    };
    expect(await moveTenantToDispatch(w.deps, id)).toMatchObject({ kind: "failed", step: "health" });
    expect((await record(id)).runtime).toBe("starter");
    expect(w.api.scriptIn(null, `t-${id}`)).toBeTruthy();
    expect(w.api.customDomainAt(`stayco.${DOMAIN}`)).toMatchObject({ service: `t-${id}` });
  });
});

describe("the security review's cases", () => {
  const appWith = (extra: Partial<PlatformEnv> = {}) => {
    const app = createApp({ dispatcher: () => new FakeDispatcher(), capability: () => noopPlatform });
    return async (request: Request) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(request, { ...(env as unknown as PlatformEnv), HOSTED_DOMAIN: DOMAIN, PLATFORM_KEY, ...extra }, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
  };
  const signedCall = (path: string, body: unknown, tenantId: string, keys: CallKeys) =>
    signRequest(
      { method: "POST", url: `https://app.${DOMAIN}${path}`, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      { direction: "tenant-to-platform", tenantId, keys, now: Date.now() },
    );
  const keysOf = (w: World, id: string) => deriveCallKeys(secretOf(w.api.scriptIn(null, `t-${id}`)!));
  const secrets = async (id: string) =>
    (await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM tenant_call_secrets WHERE tenant_id = ?").bind(id).first<{ n: number }>())!.n;

  it("refuses a tenant call from a tenant that no longer runs in starter mode, whatever secret it still holds", async () => {
    const w = world();
    const id = await starterTenant(w, "flippedco");
    const keys = await keysOf(w, id);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET runtime = 'dispatch' WHERE id = ?").bind(id).run();
    clearCallKeyCache();
    const response = await appWith()(await signedCall(TENANT_CALL_PATHS.info, {}, id, keys));
    expect(response.status).toBe(404);
  });

  it("moves without the address ever going away, and closes the starter trust path even when cleanup fails", async () => {
    const w = world();
    const id = await starterTenant(w, "inplaceco");
    const keys = await keysOf(w, id);
    const before = w.api.customDomainAt(`inplaceco.${DOMAIN}`)!;
    w.deps.config = { ...w.deps.config, namespace: "openping-tenants" };
    // The namespace's clean slate goes through; the cleanup's delete of the starter Worker fails.
    const original = w.api.deleteScript.bind(w.api);
    w.api.deleteScript = (namespace, name) => (namespace === null ? Promise.reject(new Error("cleanup refused")) : original(namespace, name));
    const outcome = await moveTenantToDispatch(w.deps, id);
    expect(outcome).toMatchObject({ kind: "failed", step: "cleanup" });
    // The hostname was re-pointed in place: never detached, the same domain.
    expect(w.api.count("detachCustomDomain")).toBe(0);
    expect(w.api.customDomainAt(`inplaceco.${DOMAIN}`)).toMatchObject({ id: before.id, service: "openping-platform" });
    // The secret went with the flip, so the starter Worker left behind can't speak for the tenant.
    expect(await secrets(id)).toBe(0);
    clearCallKeyCache();
    expect((await appWith()(await signedCall(TENANT_CALL_PATHS.info, {}, id, keys))).status).toBe(404);
    // A second run finishes the cleanup.
    w.api.deleteScript = original;
    expect(await moveTenantToDispatch(w.deps, id)).toMatchObject({ kind: "moved" });
    expect(w.api.scriptIn(null, `t-${id}`)).toBeUndefined();
  });

  it("re-points by detaching and attaching only when the API won't change a domain's Worker in place", async () => {
    const w = world();
    const id = await starterTenant(w, "fallbackco");
    w.api.repointInPlace = false;
    w.deps.config = { ...w.deps.config, namespace: "openping-tenants" };
    expect(await moveTenantToDispatch(w.deps, id)).toMatchObject({ kind: "moved" });
    expect(w.api.customDomainAt(`fallbackco.${DOMAIN}`)).toMatchObject({ service: "openping-platform" });
  });

  it("moves the tenant on its own recorded version, not the current release", async () => {
    const w = world();
    const id = await starterTenant(w, "versionco");
    const newer = { ...BUNDLE, version: "0.19.0" };
    w.deps.bundles = { current: async () => newer, version: async (v: string) => (v === BUNDLE.version ? BUNDLE : newer) };
    w.deps.config = { ...w.deps.config, namespace: "openping-tenants" };
    expect(await moveTenantToDispatch(w.deps, id)).toEqual({ kind: "moved", tenantId: id, version: BUNDLE.version });
    expect(w.api.scriptIn("openping-tenants", `t-${id}`)!.metadata.tags).toContain(`release-${BUNDLE.version}`);
  });

  it("allows a suspended or departing tenant only what dispatch mode does", async () => {
    const w = world();
    const id = await starterTenant(w, "pausedco");
    const keys = await keysOf(w, id);
    const send = appWith();
    const usage = { monitors: 1, statusPages: 1, channels: 0, at: Date.now() };
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(id).run();
    clearTenantCache();
    expect((await send(await signedCall(TENANT_CALL_PATHS.reportUsage, usage, id, keys))).status).toBe(403);
    expect((await send(await signedCall(TENANT_CALL_PATHS.audit, { action: "session.created", actor: "customer", at: Date.now() }, id, keys))).status).toBe(403);
    // It still learns it is paused, so it shows the paused page.
    expect((await send(await signedCall(TENANT_CALL_PATHS.info, {}, id, keys))).status).toBe(200);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'active', provision_state = 'deleting' WHERE id = ?").bind(id).run();
    for (const path of [TENANT_CALL_PATHS.info, TENANT_CALL_PATHS.reportUsage, TENANT_CALL_PATHS.audit, TENANT_CALL_PATHS.sendEmail]) {
      expect((await send(await signedCall(path, path === TENANT_CALL_PATHS.reportUsage ? usage : {}, id, keys))).status, path).toBe(409);
    }
  });

  it("costs one database read per unknown tenant id at most, rate limits the lookups per caller, and samples its logs", async () => {
    const reads: string[] = [];
    const db = new Proxy(env.PLATFORM_DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (reads.push(sql), target.prepare(sql));
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const lines: string[] = [];
    const { captureLogs } = await import("../src/log");
    const restore = captureLogs((l) => lines.push(l.event));
    try {
      const forgedKeys = await deriveCallKeys(generatePlatformCallSecret());
      const send = appWith({ PLATFORM_DB: db });
      for (let i = 0; i < 20; i++) expect((await send(await signedCall(TENANT_CALL_PATHS.info, {}, "zzzzzzzzzzzzzzzz", forgedKeys))).status).toBe(404);
      expect(reads.filter((sql) => /tenant_call_secrets|FROM tenants/.test(sql)).length).toBeLessThanOrEqual(1);
      expect(lines.filter((e) => e === "tenant_call.refused").length).toBeLessThanOrEqual(2);
      // With the rate limit binding refusing, no lookup happens at all.
      reads.length = 0;
      const limited = appWith({ PLATFORM_DB: db, TENANT_CALL_RATE_LIMIT: { limit: async () => ({ success: false }) } as RateLimit });
      expect((await limited(await signedCall(TENANT_CALL_PATHS.info, {}, "yyyyyyyyyyyyyyyy", forgedKeys))).status).toBe(429);
      expect(reads.filter((sql) => /tenant_call_secrets|FROM tenants/.test(sql))).toEqual([]);
    } finally {
      restore();
    }
  });

  it("caps a starter Worker's CPU and subrequests per invocation in its upload, as dispatch caps each call", async () => {
    const w = world();
    const id = await starterTenant(w, "limitsco");
    expect(w.api.scriptIn(null, `t-${id}`)!.metadata.limits).toEqual({ cpu_ms: 15_000, subrequests: 1_000 });
  });

  it("rotates a tenant's call secret: a new one on its Worker and in the platform, the old one refused", async () => {
    const w = world();
    const id = await starterTenant(w, "rotateco");
    const oldKeys = await keysOf(w, id);
    const oldSecret = secretOf(w.api.scriptIn(null, `t-${id}`)!);
    const { rotateCallSecret } = await import("../src/tenant-upload");
    expect(await rotateCallSecret(w.deps, id)).toMatchObject({ kind: "rotated" });
    const newSecret = secretOf(w.api.scriptIn(null, `t-${id}`)!);
    expect(newSecret).not.toBe(oldSecret);
    clearCallKeyCache();
    const send = appWith();
    expect((await send(await signedCall(TENANT_CALL_PATHS.info, {}, id, await deriveCallKeys(newSecret)))).status).toBe(200);
    expect((await send(await signedCall(TENANT_CALL_PATHS.info, {}, id, oldKeys))).status).toBe(404);
    // And the platform's calls to it use the new one.
    const tenant = await record(id);
    expect((await callTenant(w.deps.dispatcher, { tenant, hostedDomain: DOMAIN, platform: noopPlatform }, PLATFORM_HEALTH_PATH)).kind).toBe("response");
  });
});
