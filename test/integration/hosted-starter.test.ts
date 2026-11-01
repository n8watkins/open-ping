import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { forgetSchemaCheck } from "../../src/worker/lib/migrate";
import { HttpsPlatform, PlatformCallError, resetStarterCaches, starterFetch } from "../../src/worker/lib/hosted-starter";
import {
  INTERNAL_HEADER,
  PLAN_LIMITS,
  SIGNED_CALL_HEADERS,
  SIGNED_CALL_MAX_SKEW_MS,
  TENANT_CALL_PATHS,
  deriveCallKeys,
  encodeSignedCallProps,
  generatePlatformCallSecret,
  signRequest,
  signResponse,
  verifySignedRequest,
  verifySignedResponse,
  type CallKeys,
  type HealthResponse,
  type ScheduledRunSummary,
  type SignedCallProps,
  type TenantInfo,
} from "../../src/shared/hosted-contract";

/**
 * Starter mode through the real Worker and D1 (docs/hosted/CONTRACT.md,
 * section 10): the platform's signed calls, and everything that must not pass
 * for one: a forged, replayed, expired or cross-tenant call, and a visitor
 * sending the platform's headers. The platform's side is played by a stub of
 * the outbound fetch that verifies and signs exactly as the platform does.
 */

const ORIGIN = "https://acme.hosted.test";
const PLATFORM = "https://app.hosted.test";
const TENANT = "abcdefgh12345678";
const OTHER = "zyxwvuts87654321";
const SECRET = generatePlatformCallSecret();
const OTHER_SECRET = generatePlatformCallSecret();
const SHELL = "<!doctype html><title>OpenPing</title>";

const URLS = {
  account: `${PLATFORM}/account`,
  billing: `${PLATFORM}/billing`,
  upgrade: `${PLATFORM}/billing/upgrade`,
  signIn: `${PLATFORM}/sign-in?tenant=acme`,
  signOut: `${PLATFORM}/sign-out`,
};

const ASSETS = {
  fetch: async () => new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
} as unknown as Fetcher;

const tenantInfo = (over: Partial<TenantInfo> = {}): TenantInfo => ({
  id: TENANT,
  slug: "acme",
  status: "active",
  plan: "hosted",
  limits: PLAN_LIMITS.hosted,
  trialEndsAt: null,
  urls: URLS,
  ...over,
});

const starterEnv = (over: Partial<Env> = {}): Env =>
  ({
    ...env,
    ASSETS,
    HOSTED_MODE: "1",
    TENANT_ID: TENANT,
    HOSTED_TRANSPORT: "https",
    PLATFORM_URL: PLATFORM,
    PLATFORM_CALL_SECRET: SECRET,
    ...over,
  }) as Env;

let keys: CallKeys;
let otherKeys: CallKeys;

const callProps = (over: Partial<SignedCallProps> = {}): SignedCallProps => ({
  contract: 1,
  invocation: "platform",
  callId: crypto.randomUUID().replace(/-/g, ""),
  tenant: tenantInfo(),
  ...over,
});

/** A call as the platform makes it: signed platform-to-tenant with this tenant's keys. */
function platformRequest(
  path: string,
  init: { body?: unknown; keys?: CallKeys; tenantId?: string; props?: SignedCallProps; now?: number } = {},
): Promise<Request> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return signRequest(
    { method: body === undefined ? "GET" : "POST", url: `${ORIGIN}${path}`, body, headers: body ? { "content-type": "application/json" } : {} },
    {
      direction: "platform-to-tenant",
      tenantId: init.tenantId ?? TENANT,
      keys: init.keys ?? keys,
      now: init.now ?? Date.now(),
      props: init.props ?? callProps(),
    },
  );
}

async function call(request: Request, target: Env = starterEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** What the platform received from the tenant, verified as the platform verifies it. */
interface PlatformHit {
  path: string;
  body: unknown;
  raw: string;
  headers: Record<string, string>;
}
let hits: PlatformHit[] = [];
let infoAnswer: () => { status: number; body: unknown } = () => ({ status: 200, body: { contract: 1, tenant: tenantInfo() } });

/** Stubs the tenant's outbound fetch with the platform's endpoints: verify, record, answer signed. */
function stubPlatform(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (url.origin !== PLATFORM) throw new Error(`network_error: unexpected ${request.url}`);
    const verified = await verifySignedRequest(request, {
      direction: "tenant-to-platform",
      now: Date.now(),
      keysFor: async (id) => (id === TENANT ? keys : id === OTHER ? otherKeys : null),
    });
    if (!verified.ok) return Response.json({ error: "not_found" }, { status: 404 });
    const raw = await verified.request.text();
    hits.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null, raw, headers: Object.fromEntries(request.headers) });
    const answer =
      url.pathname === TENANT_CALL_PATHS.info
        ? infoAnswer()
        : url.pathname === TENANT_CALL_PATHS.sendEmail
          ? { status: 200, body: { ok: true, id: "email_1" } }
          : { status: 200, body: { ok: true } };
    return signResponse(
      { status: answer.status, body: JSON.stringify(answer.body) },
      { requestDirection: "tenant-to-platform", tenantId: verified.tenantId, requestNonce: verified.nonce, keys: verified.tenantId === TENANT ? keys : otherKeys },
    );
  });
}

async function readSigned<T>(response: Response, request: Request): Promise<{ status: number; body: T } | null> {
  const verified = await verifySignedResponse(response, {
    requestDirection: "platform-to-tenant",
    tenantId: TENANT,
    requestNonce: request.headers.get(SIGNED_CALL_HEADERS.nonce)!,
    keys,
  });
  return verified && { status: verified.status, body: JSON.parse(verified.text) as T };
}

const nonceCount = async (db: D1Database = env.DB) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM used_platform_call_nonces").first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keys = await deriveCallKeys(SECRET);
  otherKeys = await deriveCallKeys(OTHER_SECRET);
});

beforeEach(() => {
  hits = [];
  infoAnswer = () => ({ status: 200, body: { contract: 1, tenant: tenantInfo() } });
  forgetSchemaCheck();
  resetStarterCaches();
  stubPlatform();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a signed platform call", () => {
  it("runs with the props it carries and answers signed for that call", async () => {
    const request = await platformRequest("/__platform/health");
    const response = await call(request.clone());
    const answer = await readSigned<HealthResponse>(response, request);
    expect(answer?.status).toBe(200);
    expect(answer?.body.ok).toBe(true);
    // Health never needs the tenant's description: the call carried it.
    expect(hits.filter((h) => h.path === TENANT_CALL_PATHS.info)).toEqual([]);
  });

  it("runs the scheduler, whose usage report goes back to the platform signed as this tenant", async () => {
    const request = await platformRequest("/__platform/scheduled", { body: { runId: "run_starter", scheduledTime: Date.now(), cron: "* * * * *" } });
    const answer = await readSigned<ScheduledRunSummary>(await call(request.clone()), request);
    expect(answer?.status).toBe(200);
    expect(answer?.body).toMatchObject({ runId: "run_starter", outcome: "ran" });
    const reports = hits.filter((h) => h.path === TENANT_CALL_PATHS.reportUsage);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toMatchObject({ monitors: expect.any(Number), statusPages: expect.any(Number) });
  });

  it("is refused when replayed: the second copy is a visitor's request, and an internal path is then a 404", async () => {
    const request = await platformRequest("/__platform/health");
    expect((await call(request.clone())).status).toBe(200);
    const again = await call(request.clone());
    expect(again.status).toBe(404);
    expect(again.headers.has(SIGNED_CALL_HEADERS.signature)).toBe(false);
    expect(await again.json()).toEqual({ error: "not_found" });
  });

  it("is refused when forged with another secret, expired, from the future or tampered", async () => {
    const tampered = await platformRequest("/__platform/scheduled", { body: { runId: "a", scheduledTime: 1, cron: "x" } });
    const forged = [
      await platformRequest("/__platform/health", { keys: otherKeys }),
      await platformRequest("/__platform/health", { now: Date.now() - SIGNED_CALL_MAX_SKEW_MS - 1_000 }),
      await platformRequest("/__platform/health", { now: Date.now() + SIGNED_CALL_MAX_SKEW_MS + 1_000 }),
      new Request(tampered.url, { method: "POST", headers: tampered.headers, body: JSON.stringify({ runId: "b", scheduledTime: 1, cron: "x" }) }),
    ];
    const before = await nonceCount();
    for (const request of forged) {
      const response = await call(request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    // Nothing unsigned reached the nonce table.
    expect(await nonceCount()).toBe(before);
  });

  it("is refused across tenants: another tenant's validly signed call, or props for another tenant", async () => {
    const forOther = await platformRequest("/__platform/health", {
      keys: otherKeys,
      tenantId: OTHER,
      props: callProps({ tenant: tenantInfo({ id: OTHER, slug: "other" }) }),
    });
    expect((await call(forOther)).status).toBe(404);
    const wrongProps = await platformRequest("/__platform/health", { props: callProps({ tenant: tenantInfo({ id: OTHER }) }) });
    expect((await call(wrongProps)).status).toBe(404);
  });

  it("works on a brand new database, before the nonce table's migration is applied", async () => {
    const fresh = starterEnv({ DB: env.FRESH_DB });
    const request = await platformRequest("/__platform/health");
    const answer = await readSigned<HealthResponse>(await call(request.clone(), fresh), request);
    expect(answer?.body.ok).toBe(true);
    expect(await nonceCount(env.FRESH_DB)).toBe(1);
    expect((await call(request.clone(), fresh)).status).toBe(404);
  });
});

describe("a visitor's request", () => {
  it("can't present the platform's headers: unsigned, they are stripped and an internal path is a 404", async () => {
    for (const path of ["/__platform/health", "/__platform/scheduled", "/__platform/anything"]) {
      const p = callProps();
      const request = new Request(`${ORIGIN}${path}`, {
        method: path.endsWith("scheduled") ? "POST" : "GET",
        headers: { [INTERNAL_HEADER]: p.callId, [SIGNED_CALL_HEADERS.props]: encodeSignedCallProps(p), [SIGNED_CALL_HEADERS.tenant]: TENANT },
        body: path.endsWith("scheduled") ? JSON.stringify({ runId: "x", scheduledTime: Date.now(), cron: "x" }) : undefined,
      });
      const response = await call(request);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(hits).toEqual([]);
  });

  it("gets props from the platform's description of the tenant, kept for 30 seconds", async () => {
    const status = await call(new Request(`${ORIGIN}/api/auth/status`));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ hosted: { signInUrl: URLS.signIn } });
    await call(new Request(`${ORIGIN}/api/auth/status`));
    expect(hits.filter((h) => h.path === TENANT_CALL_PATHS.info)).toHaveLength(1);
  });

  it("never reaches the app with an x-openping header", async () => {
    let seen: Headers | null = null;
    const handler = starterFetch(async (request) => {
      seen = request.headers;
      return new Response("ok");
    });
    const response = await handler(
      new Request(`${ORIGIN}/`, { headers: { "x-openping-platform": "0123456789abcdef0123456789abcdef", "X-OpenPing-Role": "support", accept: "text/html" } }),
      starterEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect([...seen!.keys()].filter((k) => k.startsWith("x-openping-"))).toEqual([]);
  });

  it("shows a paused tenant's page to every visitor", async () => {
    infoAnswer = () => ({ status: 200, body: { contract: 1, tenant: tenantInfo({ status: "suspended" }) } });
    for (const path of ["/", "/api/auth/status", "/status"]) {
      const response = await call(new Request(`${ORIGIN}${path}`));
      expect(response.status, path).toBe(503);
      expect(await response.text()).toContain("This OpenPing is paused");
    }
  });

  it("answers 503 while the platform says the tenant isn't ready", async () => {
    infoAnswer = () => ({ status: 409, body: { error: "tenant_not_ready" } });
    const response = await call(new Request(`${ORIGIN}/api/auth/status`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hosted_unavailable" });
  });

  it("answers 503 when the platform's description is for another tenant", async () => {
    infoAnswer = () => ({ status: 200, body: { contract: 1, tenant: tenantInfo({ id: OTHER }) } });
    expect((await call(new Request(`${ORIGIN}/api/auth/status`))).status).toBe(503);
  });

  it("keeps serving the last description for a while when the platform is down, then gives up", async () => {
    let clock = Date.now();
    const handler = starterFetch((request, e, ctx) => worker.fetch(request, e, ctx), { now: () => clock });
    expect((await handler(new Request(`${ORIGIN}/api/auth/status`), starterEnv(), createExecutionContext())).status).toBe(200);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network_error: down"));
    clock += 5 * 60_000;
    expect((await handler(new Request(`${ORIGIN}/api/auth/status`), starterEnv(), createExecutionContext())).status).toBe(200);
    clock += 6 * 60_000;
    expect((await handler(new Request(`${ORIGIN}/api/auth/status`), starterEnv(), createExecutionContext())).status).toBe(503);
  });

  it("ignores an answer from the platform that isn't signed for this call", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ contract: 1, tenant: tenantInfo({ plan: "hosted_fast" }) }));
    expect((await call(new Request(`${ORIGIN}/api/auth/status`))).status).toBe(503);
  });
});

describe("the tenant's secret", () => {
  it("is needed: without it, or with a malformed one, every request answers 503", async () => {
    for (const secret of [undefined, "", "not-a-secret"]) {
      const response = await call(new Request(`${ORIGIN}/api/auth/status`), starterEnv({ PLATFORM_CALL_SECRET: secret }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "hosted_unavailable" });
    }
  });

  it("never leaves the Worker: no call to the platform carries it", async () => {
    await call(new Request(`${ORIGIN}/api/auth/status`));
    const request = await platformRequest("/__platform/scheduled", { body: { runId: "run_secret", scheduledTime: Date.now(), cron: "* * * * *" } });
    await call(request);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.raw).not.toContain(SECRET);
      expect(Object.values(hit.headers).join("\n")).not.toContain(SECRET);
    }
  });

  it("signs only as its own tenant: another tenant's Worker can't speak for this one", async () => {
    // The other tenant's Worker, configured with its own secret, calls the platform as itself.
    const platform = new HttpsPlatform({ tenantId: OTHER, platformUrl: PLATFORM, keys: Promise.resolve(otherKeys) });
    await platform.audit({ action: "session.created", actor: "customer", at: Date.now() });
    expect(hits.at(-1)!.headers[SIGNED_CALL_HEADERS.tenant]).toBe(OTHER);
    // With its secret but this tenant's id, the platform refuses it.
    const impostor = new HttpsPlatform({ tenantId: TENANT, platformUrl: PLATFORM, keys: Promise.resolve(otherKeys) });
    await expect(impostor.audit({ action: "session.created", actor: "customer", at: Date.now() })).rejects.toBeInstanceOf(PlatformCallError);
  });
});

describe("the capability over HTTPS", () => {
  it("sends email and answers the platform's result", async () => {
    const platform = new HttpsPlatform({ tenantId: TENANT, platformUrl: PLATFORM, keys: Promise.resolve(keys) });
    expect(await platform.sendEmail({ to: ["a@example.com"], subject: "Down", text: "x", category: "alert" })).toEqual({ ok: true, id: "email_1" });
    expect(hits.at(-1)).toMatchObject({ path: TENANT_CALL_PATHS.sendEmail, body: { subject: "Down" } });
  });

  it("throws, as a failed RPC would, when the platform doesn't answer or answers unsigned", async () => {
    const platform = new HttpsPlatform({ tenantId: TENANT, platformUrl: PLATFORM, keys: Promise.resolve(keys) });
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network_error"));
    await expect(platform.reportUsage({ monitors: 1, statusPages: 1, channels: 0, at: 1 })).rejects.toBeInstanceOf(PlatformCallError);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(platform.reportUsage({ monitors: 1, statusPages: 1, channels: 0, at: 1 })).rejects.toBeInstanceOf(PlatformCallError);
  });
});

describe("a plain install and a dispatch mode tenant", () => {
  it("never take the starter path, even with the vars and signed headers", async () => {
    const request = await platformRequest("/__platform/health");
    const plain = await call(request.clone(), { ...env, ASSETS, HOSTED_TRANSPORT: "https", PLATFORM_CALL_SECRET: SECRET } as Env);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe(SHELL);
    // Dispatch mode without props: the hosted gate's 503, never the signed call.
    const dispatch = await call(request.clone(), starterEnv({ HOSTED_TRANSPORT: undefined }));
    expect(dispatch.status).toBe(503);
    expect(hits).toEqual([]);
  });
});
