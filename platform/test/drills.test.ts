import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateHandoffKeyPair, tenantDatabaseName, type PlatformCapability } from "../../src/shared/hosted-contract";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import { generateMasterKey, openEscrowedKey } from "../src/keys";
import { D1BillingView } from "../src/lifecycle/billing-view";
import { DUE_TENANTS_SQL, provisionDue, type ProvisioningDeps } from "../src/provisioning";
import { DUE_SQL } from "../src/scheduling";
import { effectiveLimits, findTenantBySlug as loadTenant } from "../src/tenants";
import { leftoversSql, loadTenants, markForRemovalSql, platformSeedSql, provisionStatusSql, remainingTenantsSql, seedKeysSql } from "../../scripts/hosted-drills/seed.mjs";
import { quiesceSql, rebindSql, tenantLookupSql, unquiesceSql } from "../../scripts/hosted-drills/restore-sql.mjs";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing } from "./fake-openping";

/**
 * The launch drills' SQL (scripts/hosted-drills/, docs/hosted/LAUNCH_DRILLS.md)
 * against the real platform schema and the real provisioning, scheduling and
 * lifecycle code, with the fake Cloudflare API: the load test's tenants are
 * provisioned like sign-ups and torn down like removals, and the restore
 * drill's pause and rebind take a tenant off the air and bring it back bound
 * to a new database with its escrowed key.
 */

const DOMAIN = "openping.test";
const NAMESPACE = "openping-tenants-staging";
const PLATFORM_KEY = generateMasterKey();
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);

const BUNDLE: TenantBundle = {
  version: "0.18.0",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default { fetch() { return new Response('hi') } }", contentType: "application/javascript+module" }],
  assets: [{ path: "/index.html", content: new Uint8Array(new TextEncoder().encode("<!doctype html>")), contentType: "text/html" }],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: ["nodejs_compat"],
  assetsConfig: {},
  vars: {},
  durableObjects: [],
  migrations: [],
  d1Migrations: [],
};

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

let handoffPublicKey = "";
let api: FakeCloudflareApi;
let deps: ProvisioningDeps;
const clock = { now: NOW };

/** Statements of a drill's SQL, one by one (D1's exec doesn't take bound statements, and these are plain). */
async function exec(sql: string) {
  const statements = sql
    .split(/;\s*(?:\n|$)|;\s(?=SELECT|UPDATE|DELETE|INSERT)/)
    .map((s) => s.trim())
    .filter(Boolean);
  return env.PLATFORM_DB.batch(statements.map((s) => env.PLATFORM_DB.prepare(s)));
}

async function sweepUntilSettled() {
  for (let i = 0; i < 20; i++) {
    clock.now += 60_000;
    const outcomes = await provisionDue(deps, 50);
    if (outcomes.length === 0) return;
  }
  throw new Error("provisioning didn't settle");
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  handoffPublicKey = (await generateHandoffKeyPair()).publicKey;
});

beforeEach(async () => {
  await env.PLATFORM_DB.batch(
    ["lifecycle_notices", "scheduler_stats", "escrowed_keys", "audit_events", "slug_holds", "tenants", "accounts"].map((t) => env.PLATFORM_DB.prepare(`DELETE FROM ${t}`)),
  );
  api = new FakeCloudflareApi();
  const dispatcher = new FakeDispatcher();
  api.onScriptChange = (name, script) => {
    if (!script) dispatcher.remove(name);
    else dispatcher.register(name, fakeOpenPing(script).worker);
  };
  clock.now = NOW;
  deps = {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher,
    capability: () => noopPlatform,
    config: { hostedDomain: DOMAIN, namespace: NAMESPACE, platformKey: PLATFORM_KEY, handoffPublicKey },
    now: () => clock.now,
  };
});

let seq = 0;
const tenantId = () => `drill${String(++seq).padStart(11, "0")}`;

async function seedRun(runId: string, count: number) {
  const tenants = loadTenants({ runId, count, newTenantId: tenantId });
  await exec(platformSeedSql(tenants, { now: clock.now }));
  return tenants;
}

describe("the load test's tenants", () => {
  it("are provisioned by the platform like sign-ups, on the paid plan, with no welcome email due", async () => {
    const tenants = await seedRun("abcd", 3);
    const status = await exec(provisionStatusSql("abcd"));
    expect(status[0]!.results).toEqual([{ state: "requested", paused: 0, n: 3 }]);

    await sweepUntilSettled();
    const after = await exec(provisionStatusSql("abcd"));
    expect(after[0]!.results).toEqual([{ state: "ready", paused: 0, n: 3 }]);
    for (const t of tenants) {
      const record = await loadTenant(env.PLATFORM_DB, t.slug);
      expect(record).toMatchObject({ status: "active", plan: "hosted", provisionState: "ready" });
      expect(effectiveLimits(record!).monitors).toBe(20);
      expect(api.scriptIn(NAMESPACE, `t-${t.tenantId}`)).toBeDefined();
      expect([...api.databases.values()].some((d) => d.name === tenantDatabaseName(t.tenantId))).toBe(true);
    }
    // Each is due for the scheduler at once.
    const due = await env.PLATFORM_DB.prepare(DUE_SQL).bind(clock.now, clock.now, 100).all<{ id: string }>();
    expect(due.results.map((r) => r.id).sort()).toEqual(tenants.map((t) => t.tenantId).sort());
    // The welcome is recorded as sent, so the lifecycle job sends none.
    const welcome = await new D1BillingView(env.PLATFORM_DB).newlyReady(0, 100, { kind: "welcome", cycle: "once", staleBefore: 0 });
    expect(welcome).toEqual([]);
    // seed reads each one's database and escrowed key, which opens with PLATFORM_KEY.
    const keys = (await exec(seedKeysSql("abcd")))[0]!.results as { tenant_id: string; d1_id: string; kid: string; ciphertext: string }[];
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(await openEscrowedKey({ kid: k.kid, ciphertext: k.ciphertext }, k.tenant_id, PLATFORM_KEY)).toMatch(/=$/);
  });

  it("are torn down by the platform's own removal, and cleanup leaves nothing of them and nothing else changed", async () => {
    const tenants = await seedRun("wxyz", 2);
    const other = await seedRun("keep", 1);
    await sweepUntilSettled();
    await exec(markForRemovalSql("wxyz", { now: clock.now }));
    await sweepUntilSettled();
    expect((await exec(remainingTenantsSql("wxyz")))[0]!.results).toEqual([{ n: 0 }]);
    for (const t of tenants) {
      expect(api.scriptIn(NAMESPACE, `t-${t.tenantId}`)).toBeUndefined();
      expect([...api.databases.values()].some((d) => d.name === tenantDatabaseName(t.tenantId))).toBe(false);
    }
    await exec(leftoversSql("wxyz", tenants.map((t) => t.tenantId)));
    const accounts = await env.PLATFORM_DB.prepare("SELECT id FROM accounts").all<{ id: string }>();
    expect(accounts.results.map((r) => r.id)).toEqual([other[0]!.accountId]);
    const holds = await env.PLATFORM_DB.prepare("SELECT slug FROM slug_holds").all();
    expect(holds.results).toEqual([]);
    expect((await exec(remainingTenantsSql("keep")))[0]!.results).toEqual([{ n: 1 }]);
  });
});

describe("the restore drill's pause and rebind", () => {
  async function readyTenant() {
    const [t] = await seedRun("rstr", 1);
    await sweepUntilSettled();
    return t!;
  }

  it("takes a ready tenant off the air: not routed, not scheduled, not provisioned", async () => {
    const t = await readyTenant();
    const lookup = await exec(tenantLookupSql(t.slug));
    expect(lookup[0]!.results).toMatchObject([{ id: t.tenantId, provision_state: "ready" }]);
    await exec(quiesceSql(t.tenantId, { at: clock.now, note: "restore drill" }));
    expect(await loadTenant(env.PLATFORM_DB, t.slug)).toMatchObject({ provisionState: "db_created" });
    const due = await env.PLATFORM_DB.prepare(DUE_SQL).bind(clock.now + 3_600_000, clock.now + 3_600_000, 100).all();
    expect(due.results).toEqual([]);
    const sweep = await env.PLATFORM_DB.prepare(DUE_TENANTS_SQL).bind(clock.now + 3_600_000, 100).all();
    expect(sweep.results).toEqual([]);
    expect(await provisionDue(deps, 50)).toEqual([]);
  });

  it("puts it back as it was when the drill stops early", async () => {
    const t = await readyTenant();
    const at = clock.now;
    await exec(quiesceSql(t.tenantId, { at, note: "restore drill" }));
    await exec(unquiesceSql(t.tenantId, { quiescedAt: at, now: at + 1 }));
    expect(await loadTenant(env.PLATFORM_DB, t.slug)).toMatchObject({ provisionState: "ready" });
  });

  it("is uploaded again by provisioning, bound to the new database, with its escrowed MASTER_KEY", async () => {
    const t = await readyTenant();
    const escrowed = await env.PLATFORM_DB.prepare("SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ?").bind(t.tenantId).first<{ kid: string; ciphertext: string }>();
    const masterKey = await openEscrowedKey(escrowed!, t.tenantId, PLATFORM_KEY);
    const at = clock.now;
    await exec(quiesceSql(t.tenantId, { at, note: "restore drill" }));
    // The drill deletes the database and makes it again: a new id under the same name.
    const old = [...api.databases.values()].find((d) => d.name === tenantDatabaseName(t.tenantId))!;
    await api.deleteDatabase(old.id);
    const fresh = await api.createDatabase(tenantDatabaseName(t.tenantId));
    const rebound = await exec(rebindSql(t.tenantId, { d1Id: fresh.id, quiescedAt: at, now: at + 1 }));
    expect(rebound[1]!.results).toEqual([{ d1_id: fresh.id, provision_paused_at: null }]);

    await sweepUntilSettled();
    expect(await loadTenant(env.PLATFORM_DB, t.slug)).toMatchObject({ provisionState: "ready" });
    const script = api.scriptIn(NAMESPACE, `t-${t.tenantId}`)!;
    expect(script.metadata.bindings).toContainEqual({ type: "d1", name: "DB", database_id: fresh.id });
    expect(script.metadata.bindings).toContainEqual({ type: "secret_text", name: "MASTER_KEY", text: masterKey });
    // The same key: no new one was made.
    const keys = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM escrowed_keys WHERE tenant_id = ?").bind(t.tenantId).first<{ n: number }>();
    expect(keys?.n).toBe(1);
  });

  it("doesn't rebind a tenant someone else changed meanwhile", async () => {
    const t = await readyTenant();
    const at = clock.now;
    await exec(quiesceSql(t.tenantId, { at, note: "restore drill" }));
    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_paused_at = ? WHERE id = ?").bind(at + 5, t.tenantId).run();
    const rebound = await exec(rebindSql(t.tenantId, { d1Id: "other", quiescedAt: at, now: at + 1 }));
    expect(rebound[1]!.results).toEqual([{ d1_id: expect.not.stringMatching(/^other$/), provision_paused_at: at + 5 }]);
  });
});
