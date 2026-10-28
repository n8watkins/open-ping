import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateHandoffKeyPair, isTenantId, tenantDatabaseName, type PlatformCapability } from "../../src/shared/hosted-contract";
import { keyIdFor } from "../../src/worker/lib/crypto";
import { createApp } from "../src/app";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey, openEscrowedKey } from "../src/keys";
import {
  PROVISION_MAX_ATTEMPTS,
  backoffMs,
  newTenantId,
  provisionDue,
  removeTenant,
  requestTenant,
  runProvisioning,
  type ProvisioningDeps,
} from "../src/provisioning";
import { checkSlugAvailability } from "../src/slugs";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { BUNDLED_SCHEMA_VERSION, fakeOpenPing, type FakeOpenPingState } from "./fake-openping";

const DOMAIN = "openping.test";
const NAMESPACE = "openping-tenants-test";
const PLATFORM_KEY = generateMasterKey();
let HANDOFF_PUBLIC_KEY = "";

const text = (s: string) => new Uint8Array(new TextEncoder().encode(s));

const BUNDLE: TenantBundle = {
  version: "0.10.1",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default { fetch() { return new Response('hi') } }", contentType: "application/javascript+module" }],
  assets: [
    { path: "/index.html", content: text("<!doctype html><title>OpenPing</title>"), contentType: "text/html" },
    { path: "/assets/app.js", content: text("console.log(1)"), contentType: "text/javascript" },
    { path: "/assets/app.css", content: text("body{}"), contentType: "text/css" },
  ],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: ["nodejs_compat"],
  assetsConfig: { not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"] },
  vars: { WORKERS_PLAN: "paid", WAITLIST_ENABLED: "false", HOME_PAGE: "status" },
};

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

interface World {
  deps: ProvisioningDeps;
  api: FakeCloudflareApi;
  dispatcher: FakeDispatcher;
  tenants: Map<string, FakeOpenPingState>;
  clock: { now: number };
}

function world(): World {
  const api = new FakeCloudflareApi();
  const dispatcher = new FakeDispatcher();
  const tenants = new Map<string, FakeOpenPingState>();
  api.onScriptChange = (name, script) => {
    if (!script) {
      dispatcher.remove(name);
      tenants.delete(name);
      return;
    }
    const fake = fakeOpenPing(script);
    dispatcher.register(name, fake.worker);
    tenants.set(name, fake.state);
  };
  const clock = { now: Date.UTC(2026, 10, 1) };
  const deps: ProvisioningDeps = {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher,
    capability: () => noopPlatform,
    config: { hostedDomain: DOMAIN, namespace: NAMESPACE, platformKey: PLATFORM_KEY, handoffPublicKey: HANDOFF_PUBLIC_KEY },
    now: () => clock.now,
  };
  return { deps, api, dispatcher, tenants, clock };
}

let accountSeq = 0;
async function newAccount(): Promise<string> {
  accountSeq++;
  const id = `acc_prov${accountSeq}`;
  await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)")
    .bind(id, `prov${accountSeq}@example.com`)
    .run();
  return id;
}

async function signUp(w: World, slug: string): Promise<string> {
  const result = await requestTenant(env.PLATFORM_DB, { accountId: await newAccount(), slug, now: w.clock.now });
  if (!result.ok) throw new Error(`sign-up refused: ${result.reason}`);
  return result.tenantId;
}

async function row(tenantId: string) {
  return env.PLATFORM_DB.prepare(
    "SELECT provision_state, provision_attempts, provision_error, provision_next_at, provision_lease_until, d1_id, version, provisioned_at FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<Record<string, any>>();
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE tenant_id = ? ORDER BY id").bind(tenantId).all<{ action: string }>();
  return rows.results.map((r) => r.action);
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  HANDOFF_PUBLIC_KEY = (await generateHandoffKeyPair()).publicKey;
});

// The sweep looks at every tenant, so each test starts with none.
beforeEach(async () => {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM escrowed_keys"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM slug_holds"),
  ]);
});

describe("tenant ids", () => {
  it("are 16 characters of [a-z0-9], and differ", () => {
    const ids = new Set(Array.from({ length: 200 }, newTenantId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isTenantId(id), id).toBe(true);
  });
});

describe("requestTenant", () => {
  it("records a trial tenant in state requested", async () => {
    const w = world();
    const id = await signUp(w, "  Fresh-Co ");
    const t = await env.PLATFORM_DB.prepare("SELECT slug, script_name, status, plan, provision_state, trial_ends_at FROM tenants WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    expect(t).toEqual({
      slug: "fresh-co",
      script_name: `t-${id}`,
      status: "trial",
      plan: "trial",
      provision_state: "requested",
      trial_ends_at: w.clock.now + 14 * 86_400_000,
    });
  });

  it("refuses a reserved, malformed or taken slug", async () => {
    const w = world();
    await signUp(w, "takenco");
    const account = await newAccount();
    for (const [slug, reason] of [
      ["admin", "reserved"],
      ["a", "length"],
      ["bad_slug", "characters"],
      ["takenco", "taken"],
    ] as const) {
      expect(await requestTenant(env.PLATFORM_DB, { accountId: account, slug, now: w.clock.now })).toEqual({ ok: false, slug, reason });
    }
  });
});

describe("runProvisioning", () => {
  it("takes a new tenant from requested to ready, with its own database, key, vars and assets", async () => {
    const w = world();
    const id = await signUp(w, "happyco");
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "ready", tenantId: id });

    const r = await row(id);
    expect(r).toMatchObject({ provision_state: "ready", provision_attempts: 0, provision_error: null, provision_lease_until: null, version: "0.10.1" });
    expect(r!.provisioned_at).toBe(w.clock.now);

    // Its database, by the contract's name.
    const db = w.api.databases.get(r!.d1_id);
    expect(db?.name).toBe(tenantDatabaseName(id));

    // Its script, with every binding the contract asks for.
    const script = w.api.scriptIn(NAMESPACE, `t-${id}`)!;
    expect(script.metadata.main_module).toBe("index.js");
    expect(script.metadata.compatibility_date).toBe("2024-12-30");
    expect(script.metadata.tags).toEqual(["openping", `tenant-${id}`, "release-0.10.1"]);
    expect(script.metadata.assets?.config).toEqual(BUNDLE.assetsConfig);
    expect(script.assetPaths.sort()).toEqual(["/assets/app.css", "/assets/app.js", "/index.html"]);
    const state = w.tenants.get(`t-${id}`)!;
    expect(state.env).toMatchObject({
      DB: `d1:${r!.d1_id}`,
      HOSTED_MODE: "1",
      TENANT_ID: id,
      HANDOFF_PUBLIC_KEY,
      WORKERS_PLAN: "paid",
    });
    expect(script.metadata.bindings.find((b) => b.name === "MASTER_KEY")?.type).toBe("secret_text");
    expect(script.metadata.bindings.find((b) => b.name === "ASSETS")).toEqual({ type: "assets", name: "ASSETS" });

    // Its MASTER_KEY is escrowed, and the escrowed copy is the one it got.
    const escrowed = await env.PLATFORM_DB.prepare("SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ?").bind(id).all<{ kid: string; ciphertext: string }>();
    expect(escrowed.results).toHaveLength(1);
    const key = await openEscrowedKey(escrowed.results[0]!, id, PLATFORM_KEY);
    expect(key).toBe(state.env.MASTER_KEY);
    expect(escrowed.results[0]!.kid).toBe(await keyIdFor(key));
    expect(escrowed.results[0]!.ciphertext).not.toContain(key);

    // Migrated by one platform call, then healthy.
    expect(state.schemaVersion).toBe(BUNDLED_SCHEMA_VERSION);
    expect(state.scheduledRuns).toHaveLength(1);
    expect(state.scheduledRuns[0]!.runId).toMatch(new RegExp(`^provision-${id}-`));
    expect(await auditActions(id)).toEqual(["tenant.provisioned"]);

    // And the router now dispatches visitors to it.
    const app = createApp({ dispatcher: () => w.dispatcher, capability: () => noopPlatform });
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://happyco.${DOMAIN}/`), env as unknown as PlatformEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OpenPing for happyco");
  });

  it("uploads only the assets Cloudflare doesn't already have", async () => {
    const w = world();
    await runProvisioning(w.deps, await signUp(w, "firstco"), { force: true });
    expect(w.api.count("uploadAssets")).toBe(2); // three new files, two per bucket
    await runProvisioning(w.deps, await signUp(w, "secondco"), { force: true });
    expect(w.api.count("uploadAssets")).toBe(2); // same release: nothing new
    expect(w.api.count("putScript")).toBe(2);
  });

  it("does nothing for a tenant that is already ready, or doesn't exist", async () => {
    const w = world();
    const id = await signUp(w, "doneco");
    await runProvisioning(w.deps, id, { force: true });
    const calls = w.api.calls.length;
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "ready", tenantId: id });
    expect(await runProvisioning(w.deps, "nosuchtenant0000")).toEqual({ kind: "missing", tenantId: "nosuchtenant0000" });
    expect(await runProvisioning(w.deps, "not an id")).toEqual({ kind: "missing", tenantId: "not an id" });
    expect(w.api.calls.length).toBe(calls);
  });

  it("schedules a retry with backoff when a step fails, and the sweep finishes the job", async () => {
    const w = world();
    const id = await signUp(w, "retryco");
    w.api.failNext("putScript", { status: 503 });

    const first = await runProvisioning(w.deps, id, { force: true });
    expect(first).toMatchObject({ kind: "retry", state: "db_created", attempts: 1, nextAt: w.clock.now + backoffMs(1) });
    const r = await row(id);
    expect(r).toMatchObject({ provision_state: "db_created", provision_attempts: 1, provision_lease_until: null });
    expect(r!.provision_error).toMatch(/^db_created: Cloudflare API fake\.putScript failed \(503\)/);

    // Not due yet: the sweep leaves it alone.
    expect(await provisionDue(w.deps)).toEqual([]);
    w.clock.now += backoffMs(1);
    expect(await provisionDue(w.deps)).toEqual([{ kind: "ready", tenantId: id }]);
    expect(w.api.databases.size).toBe(1); // the database from the first run was kept, not made again
  });

  it("recovers a database whose create answer was lost, instead of making a second one", async () => {
    const w = world();
    const id = await signUp(w, "lostco");
    w.api.failNext("createDatabase", { status: 0, when: "after" });
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "ready", tenantId: id });
    expect(w.api.databases.size).toBe(1);
  });

  it("retries a first run that reports a failed migration", async () => {
    const w = world();
    const id = await signUp(w, "migrateco");
    w.api.onScriptChange = (name, script) => {
      const fake = fakeOpenPing(script!);
      fake.state.failNextRun = true;
      w.dispatcher.register(name, fake.worker);
      w.tenants.set(name, fake.state);
    };
    const first = await runProvisioning(w.deps, id, { force: true });
    expect(first).toMatchObject({ kind: "retry", state: "uploaded", error: "first run failed: migration 0004 failed" });
    w.clock.now += backoffMs(1);
    expect(await runProvisioning(w.deps, id)).toEqual({ kind: "ready", tenantId: id });
  });

  it("rolls back cleanly after the last allowed failure, and frees the slug", async () => {
    const w = world();
    const id = await signUp(w, "doomedco");
    w.api.failAlways("putScript", { status: 500 });

    let outcome = await runProvisioning(w.deps, id, { force: true });
    for (let attempt = 1; attempt < PROVISION_MAX_ATTEMPTS - 1; attempt++) {
      expect(outcome).toMatchObject({ kind: "retry", state: "db_created", attempts: attempt });
      w.clock.now += backoffMs(attempt);
      outcome = await runProvisioning(w.deps, id);
    }
    // The last failure: torn down at once, in the same run.
    w.clock.now += backoffMs(PROVISION_MAX_ATTEMPTS - 1);
    expect(await runProvisioning(w.deps, id)).toEqual({ kind: "removed", tenantId: id });

    expect(await row(id)).toBeNull();
    expect(w.api.databases.size).toBe(0);
    expect(w.api.count("deleteScript")).toBe(1);
    const keys = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM escrowed_keys WHERE tenant_id = ?").bind(id).first<{ n: number }>();
    expect(keys!.n).toBe(0);
    expect(await auditActions(id)).toEqual(["tenant.provision_failed", "tenant.removed"]);
    // Never served anyone, so the name is free again at once.
    expect(await checkSlugAvailability(env.PLATFORM_DB, "doomedco", w.clock.now)).toEqual({ ok: true, slug: "doomedco" });
  });

  it("keeps retrying a teardown that fails, without giving up", async () => {
    const w = world();
    const id = await signUp(w, "stuckco");
    await runProvisioning(w.deps, id, { force: true });
    w.api.failAlways("deleteDatabase", { status: 502 });
    expect(await removeTenant(w.deps, id)).toMatchObject({ kind: "retry", state: "deleting", attempts: 1 });
    for (let i = 0; i < PROVISION_MAX_ATTEMPTS + 2; i++) {
      w.clock.now += 3_600_000;
      expect(await runProvisioning(w.deps, id)).toMatchObject({ kind: "retry", state: "deleting" });
    }
    w.api.heal("deleteDatabase");
    w.clock.now += 3_600_000;
    expect(await provisionDue(w.deps)).toEqual([{ kind: "removed", tenantId: id }]);
    expect(w.api.databases.size).toBe(0);
    expect(w.api.scripts.size).toBe(0);
  });

  it("removes a ready tenant and holds its slug, so nobody else takes its address", async () => {
    const w = world();
    const id = await signUp(w, "goneco");
    await runProvisioning(w.deps, id, { force: true });
    expect(await removeTenant(w.deps, id)).toEqual({ kind: "removed", tenantId: id });
    expect(w.api.scripts.size).toBe(0);
    expect(await checkSlugAvailability(env.PLATFORM_DB, "goneco", w.clock.now)).toEqual({ ok: false, slug: "goneco", reason: "taken" });
    expect(await checkSlugAvailability(env.PLATFORM_DB, "goneco", w.clock.now + 91 * 86_400_000)).toMatchObject({ ok: true });
  });

  it("lets only one run work on a tenant at a time", async () => {
    const w = world();
    const id = await signUp(w, "leaseco");
    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_lease_until = ? WHERE id = ?").bind(w.clock.now + 60_000, id).run();
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "busy", tenantId: id });
    expect(await provisionDue(w.deps)).toEqual([]);
    expect(w.api.calls).toHaveLength(0);
    // A crashed run's lease runs out, and then the sweep takes over.
    w.clock.now += 60_000;
    expect(await provisionDue(w.deps)).toContainEqual({ kind: "ready", tenantId: id });
  });

  it("tears down instead of advancing when the tenant is removed in the middle of a step", async () => {
    const w = world();
    const id = await signUp(w, "raceco");
    const original = w.api.putScript.bind(w.api);
    w.api.putScript = async (...args) => {
      const result = await original(...args);
      // The owner removes the tenant while its upload is in flight.
      await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_state = 'deleting' WHERE id = ?").bind(id).run();
      return result;
    };
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "removed", tenantId: id });
    expect(w.api.scripts.size).toBe(0);
    expect(w.api.databases.size).toBe(0);
  });
});
