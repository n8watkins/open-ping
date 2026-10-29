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
  DUE_TENANTS_SQL,
  removeTenant,
  requestTenant,
  resumeProvisioning,
  runProvisioning,
  type ProvisioningDeps,
} from "../src/provisioning";
import { PermanentError } from "../src/errors";
import { handleProvisionBatch, type ProvisionMessage } from "../src/provisioning-queue";
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
  vars: { WORKERS_PLAN: "paid", WAITLIST_ENABLED: "false", HOME_PAGE: "status", CONFIRM_REGIONS: "wnam,weur" },
  durableObjects: [{ name: "REGION_PROBE", className: "RegionProbe" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["RegionProbe"] }],
  d1Migrations: [],
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
    "SELECT provision_state, provision_attempts, provision_error, provision_next_at, provision_lease_until, provision_paused_at, d1_id, version, provisioned_at FROM tenants WHERE id = ?",
  )
    .bind(tenantId)
    .first<Record<string, any>>();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.PLATFORM_DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
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
    // The bundle's own Durable Object, its migration and its var, straight from its config.
    expect(script.metadata.bindings).toContainEqual({ type: "durable_object_namespace", name: "REGION_PROBE", class_name: "RegionProbe" });
    expect(script.metadata.migrations).toEqual({ new_tag: "v1", steps: [{ new_sqlite_classes: ["RegionProbe"] }] });
    expect(state.env.CONFIRM_REGIONS).toBe("wnam,weur");
    expect(script.migrationTag).toBe("v1");
    expect((await env.PLATFORM_DB.prepare("SELECT do_migration_tag FROM tenants WHERE id = ?").bind(id).first())!.do_migration_tag).toBe("v1");

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
    expect(r).toMatchObject({ provision_state: "db_created", provision_attempts: 1, provision_lease_until: null, provision_paused_at: null });
    expect(r!.provision_error).toMatch(/^db_created: Cloudflare API fake\.putScript failed \(503\)/);

    // Not due yet: the sweep leaves it alone.
    expect(await provisionDue(w.deps)).toEqual([]);
    w.clock.now += backoffMs(1);
    expect(await provisionDue(w.deps)).toEqual([{ kind: "ready", tenantId: id }]);
    expect(w.api.databases.size).toBe(1); // the database from the first run was kept, not made again
  });

  it("retries an upload whose answer was lost from a clean script, so its migrations apply once", async () => {
    const w = world();
    const id = await signUp(w, "lostuploadco");
    // The first upload lands (migration v1 applied) but its answer never arrives.
    w.api.failNext("putScript", { status: 0, when: "after" });
    expect(await runProvisioning(w.deps, id, { force: true })).toMatchObject({ kind: "retry", state: "db_created" });
    expect(w.api.scriptIn(NAMESPACE, `t-${id}`)?.migrationTag).toBe("v1");
    w.clock.now += backoffMs(1);
    // Sending new_tag v1 again to a script already at v1 would be refused; the retry deletes it first.
    expect(await runProvisioning(w.deps, id)).toEqual({ kind: "ready", tenantId: id });
    // Every upload clears the way first, whatever the attempt count says.
    expect(w.api.count("deleteScript")).toBe(2);
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

  it("pauses, with nothing rolled back, after the last allowed failure, and resumes once the owner fixes it", async () => {
    const w = world();
    const id = await signUp(w, "doomedco");
    w.api.failAlways("putScript", { status: 500 });

    let outcome = await runProvisioning(w.deps, id, { force: true });
    for (let attempt = 1; attempt < PROVISION_MAX_ATTEMPTS; attempt++) {
      expect(outcome).toMatchObject({ kind: "retry", state: "db_created", attempts: attempt });
      w.clock.now += backoffMs(attempt);
      outcome = await runProvisioning(w.deps, id);
    }
    expect(outcome).toMatchObject({ kind: "paused", state: "db_created" });
    const r = await row(id);
    expect(r).toMatchObject({ provision_state: "db_created", provision_next_at: null, provision_lease_until: null });
    expect(r!.provision_paused_at).toBe(w.clock.now);
    // Nothing was thrown away: the database and the key are still there.
    expect(w.api.databases.size).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM escrowed_keys WHERE tenant_id = ?", id)).toBe(1);
    expect(await auditActions(id)).toEqual(["tenant.provision_paused"]);
    // Paused tenants are left alone by the sweep and by any message.
    w.clock.now += 86_400_000;
    expect(await provisionDue(w.deps)).toEqual([]);
    expect(await runProvisioning(w.deps, id)).toMatchObject({ kind: "paused" });
    // The address stays the customer's.
    expect(await checkSlugAvailability(env.PLATFORM_DB, "doomedco", w.clock.now)).toMatchObject({ ok: false, reason: "taken" });

    w.api.heal("putScript");
    expect(await resumeProvisioning(w.deps, id)).toEqual({ kind: "ready", tenantId: id });
  });

  it("pauses at once on a failure retrying can't fix", async () => {
    for (const [what, fail] of [
      ["a refused API token", (w: World) => w.api.failNext("createDatabase", { status: 403 })],
      ["a broken bundle", (w: World) => (w.deps.bundles = { current: async () => Promise.reject(new PermanentError("tenant bundle: releases/current is missing")) })],
    ] as const) {
      const w = world();
      const id = await signUp(w, `perm${what.length}co`);
      fail(w);
      expect(await runProvisioning(w.deps, id, { force: true }), what).toMatchObject({ kind: "paused" });
      expect((await row(id))!.provision_attempts, what).toBe(1);
    }
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

describe("the lease", () => {
  it("keeps a run that lost its lease from writing anything", async () => {
    const w = world();
    const id = await signUp(w, "stolenco");
    const original = w.api.createDatabase.bind(w.api);
    w.api.createDatabase = async (name) => {
      const db = await original(name);
      // The run stalls past its lease, and another run takes the tenant.
      await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_lease_token = 'someone-else' WHERE id = ?").bind(id).run();
      return db;
    };
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "busy", tenantId: id });
    const r = await row(id);
    // Its step's result was not written, and the other run's lease is untouched.
    expect(r!.provision_state).toBe("requested");
    expect((await env.PLATFORM_DB.prepare("SELECT provision_lease_token AS t FROM tenants WHERE id = ?").bind(id).first<{ t: string }>())!.t).toBe("someone-else");
  });

  it("is renewed before every step, so a long run keeps it", async () => {
    const w = world();
    const id = await signUp(w, "slowco");
    const leases: number[] = [];
    const slow = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      leases.push((await row(id))!.provision_lease_until);
      w.clock.now += 90_000; // each step takes most of a lease
      return f(...a);
    };
    w.api.createDatabase = slow(w.api.createDatabase.bind(w.api));
    w.api.putScript = slow(w.api.putScript.bind(w.api));
    expect(await runProvisioning(w.deps, id, { force: true })).toEqual({ kind: "ready", tenantId: id });
    expect(leases).toHaveLength(2);
    // Renewed from the later step's start, not left at the first step's.
    expect(leases[1]! - leases[0]!).toBeGreaterThanOrEqual(90_000);
  });
});

describe("escrow", () => {
  it("keeps one active key per tenant even when two runs race, and uploads that one", async () => {
    const w = world();
    const id = await signUp(w, "raceescrowco");
    const { ensureMasterKey } = await import("../src/keys");
    const [a, b] = await Promise.all([
      ensureMasterKey(env.PLATFORM_DB, id, PLATFORM_KEY, 1),
      ensureMasterKey(env.PLATFORM_DB, id, PLATFORM_KEY, 1),
    ]);
    expect(a.masterKey).toBe(b.masterKey);
    expect(await count("SELECT COUNT(*) AS n FROM escrowed_keys WHERE tenant_id = ? AND retired_at IS NULL", id)).toBe(1);
    await runProvisioning(w.deps, id, { force: true });
    expect(w.tenants.get(`t-${id}`)!.env.MASTER_KEY).toBe(a.masterKey);
  });
});

describe("the sweep", () => {
  it("reads only tenants still being provisioned, through the partial index", async () => {
    const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${DUE_TENANTS_SQL}`).bind(0, 10).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    expect(details).toContain("idx_tenants_provisioning");
    expect(details).not.toMatch(/SCAN tenants(?! USING)/);
  });
});

describe("the provisioning queue", () => {
  function batchOf(ids: string[]) {
    const acks: string[] = [];
    const retries: { id: string; delaySeconds?: number }[] = [];
    const batch = {
      queue: "openping-provision",
      messages: ids.map((tenantId, i) => ({
        id: `m${i}`,
        attempts: 1,
        body: { tenantId },
        ack: () => acks.push(tenantId),
        retry: (o?: { delaySeconds?: number }) => retries.push({ id: tenantId, delaySeconds: o?.delaySeconds }),
      })),
    } as unknown as MessageBatch<ProvisionMessage>;
    return { batch, acks, retries };
  }
  function fakeQueue() {
    const sent: { body: ProvisionMessage; delaySeconds?: number }[] = [];
    const queue = { send: async (body: ProvisionMessage, o?: { delaySeconds?: number }) => void sent.push({ body, delaySeconds: o?.delaySeconds }) } as unknown as Queue<ProvisionMessage>;
    return { queue, sent };
  }

  it("runs a new tenant to ready and acks the message", async () => {
    const w = world();
    const id = await signUp(w, "queuedco");
    const { batch, acks } = batchOf([id]);
    const { queue, sent } = fakeQueue();
    expect(await handleProvisionBatch(w.deps, batch, queue)).toEqual([{ kind: "ready", tenantId: id }]);
    expect(acks).toEqual([id]);
    expect(sent).toEqual([]);
  });

  it("schedules a failed step as a new delayed message, and retries a held tenant later", async () => {
    const w = world();
    const id = await signUp(w, "queueretryco");
    w.api.failNext("createDatabase", { status: 503 });
    const first = batchOf([id]);
    const q = fakeQueue();
    await handleProvisionBatch(w.deps, first.batch, q.queue);
    expect(first.acks).toEqual([id]);
    expect(q.sent).toEqual([{ body: { tenantId: id }, delaySeconds: backoffMs(1) / 1000 + 1 }]);

    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_next_at = NULL, provision_lease_until = ? WHERE id = ?").bind(w.clock.now + 60_000, id).run();
    const held = batchOf([id]);
    await handleProvisionBatch(w.deps, held.batch, q.queue);
    expect(held.retries).toEqual([{ id, delaySeconds: 60 }]);
  });
});
