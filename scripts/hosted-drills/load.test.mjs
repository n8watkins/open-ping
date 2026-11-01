// The load test end to end against a fake staging account: seed, run,
// report and cleanup, with the platform's provisioning, scheduler and
// teardown played by the fake over the real schemas; and the SQL it sends,
// checked against the real platform and OpenPing migrations.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptConfig } from "../../src/worker/lib/secret-config.ts";
import { openEscrowedKey } from "./keys.mjs";
import { ACCOUNT_ID_ENV, ANALYTICS_TOKEN_ENV, main } from "./load.mjs";
import { PLATFORM_KEY_ENV } from "./restore.mjs";
import { leftoversSql, loadTenants, markForRemovalSql, platformSeedSql } from "./seed.mjs";
import { FakeStaging } from "./testing/fake-staging.mjs";

const STAGING = {
  name: "openping-platform-staging",
  vars: { HOSTED_DOMAIN: "staging.openping.test" },
  d1_databases: [{ binding: "PLATFORM_DB", database_name: "openping-platform-staging" }],
  r2_buckets: [{ binding: "EXPORTS", bucket_name: "openping-tenant-exports-staging" }],
};

let root;
let configPath;
let fake;
let logs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "load-test-"));
  configPath = join(root, "staging.jsonc");
  writeFileSync(configPath, JSON.stringify(STAGING));
  fake = new FakeStaging({ root });
  logs = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function load(command, extra = [], env = {}) {
  return main([command, "--env", "staging", "--config", configPath, "--confirm", STAGING.name, ...extra], {
    run: fake.run,
    fetch: fake.fetch,
    log: (line) => logs.push(line),
    env: { [PLATFORM_KEY_ENV]: fake.platformKey, [ANALYTICS_TOKEN_ENV]: "tok_analytics_secret", [ACCOUNT_ID_ENV]: "0123456789abcdef0123456789abcdef", ...env },
    now: fake.now,
    wait: fake.wait,
    root,
  });
}

const loadTenantsInPlatform = () => fake.platform.db.prepare("SELECT * FROM tenants WHERE slug LIKE 'lt-%'").all();

describe("the load test", () => {
  it("seeds tenants through provisioning, runs, reports a pass, and cleans up everything it made", async () => {
    const state = await load("seed", ["--tenants", "3", "--monitors", "20"]);
    expect(fake.workers.has("openping-loadtest-echo-staging")).toBe(true);
    const tenants = loadTenantsInPlatform();
    expect(tenants).toHaveLength(3);
    for (const t of tenants) expect(t).toMatchObject({ provision_state: "ready", status: "active", plan: "hosted" });
    // Each tenant's 20 monitors are sealed with its own escrowed key and point at the echo Worker.
    const t = tenants[0];
    const key = fake.platform.db.prepare("SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ?").get(t.id);
    const masterKey = await openEscrowedKey(key, t.id, fake.platformKey);
    const monitors = fake.databases.get(`openping-t-${t.id}`).db.prepare("SELECT * FROM monitors ORDER BY name").all();
    expect(monitors).toHaveLength(20);
    const urls = await Promise.all(monitors.map(async (m) => (await decryptConfig({ MASTER_KEY: masterKey }, JSON.parse(m.config))).url));
    expect(urls.every((u) => u.startsWith("https://openping-loadtest-echo-staging.fake.workers.dev/"))).toBe(true);
    expect(urls.filter((u) => !u.includes("/ok?"))).toHaveLength(3);
    // No welcome email will go out.
    expect(fake.platform.db.prepare("SELECT COUNT(*) AS n FROM lifecycle_notices WHERE kind = 'welcome' AND state = 'sent'").get().n).toBe(3);

    const report = await load("run", ["--run", state.runId, "--duration", "60m", "--warmup", "13m"]);
    expect(report.criteria.filter((c) => c.pass !== true)).toEqual([]);
    expect(report.runs.missed).toBe(0);
    expect(report.runs.total).toBe(15);
    expect(report.queueLagMs.max).toBe(4000);
    expect(report.health).toMatchObject({ failures: 0 });
    // The fake's analytics: 1,000 rows written per tenant database in the hour.
    expect(report.d1PerTenant.rowsWritten).toBe(1000);
    expect(report.cost.total).toBeGreaterThan(0.72);
    expect(report.cost.total).toBeLessThan(0.83);
    expect(readFileSync(join(root, ".hosted-drills", `load-${state.runId}-report.md`), "utf8")).toMatch(/^# Load test report: PASS/);
    expect(logs.join("\n")).not.toContain("tok_analytics_secret");
    expect(logs.join("\n")).not.toContain(fake.platformKey);

    await load("cleanup", ["--run", state.runId]);
    expect(loadTenantsInPlatform()).toEqual([]);
    expect([...fake.databases.keys()]).toEqual(["openping-platform-staging"]);
    expect(fake.workers.size).toBe(0);
    for (const table of ["accounts", "slug_holds", "scheduler_stats", "lifecycle_notices", "escrowed_keys", "audit_events"]) {
      expect(fake.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, table).toBe(0);
    }
    expect(readdirSync(join(root, ".hosted-drills")).filter((f) => f.endsWith(".sql"))).toEqual([]);
  });

  it("fails the report when the scheduler misses runs and the queue lags", async () => {
    const state = await load("seed", ["--tenants", "2"]);
    fake.lagMs = () => 75_000;
    const tenantId = loadTenantsInPlatform()[0].id;
    // One tenant stops being scheduled half way through.
    const tick = fake.tick.bind(fake);
    fake.tick = async () => {
      if (fake.now() > state.createdAt + 45 * 60_000) fake.platform.db.prepare("UPDATE tenants SET schedule_next_at = ? WHERE id = ?").run(fake.now() + 3_600_000, tenantId);
      await tick();
    };
    const report = await load("run", ["--run", state.runId, "--duration", "60m"]);
    expect(report.verdict).toBe("fail");
    expect(report.runs.missed).toBeGreaterThan(0);
    expect(report.criteria.find((c) => c.name.startsWith("Queue lag")).pass).toBe(false);
  });

  it("stops seeding when provisioning pauses a tenant, and continues with seed --run", async () => {
    const tick = fake.tick.bind(fake);
    let paused = false;
    fake.tick = async () => {
      const t = fake.platform.db.prepare("SELECT id FROM tenants WHERE slug LIKE 'lt-%-002'").get();
      if (t && !paused) {
        fake.platform.db.prepare("UPDATE tenants SET provision_paused_at = 1, provision_error = 'uploaded: Cloudflare API 400' WHERE id = ?").run(t.id);
        paused = true;
      }
      await tick();
    };
    await expect(load("seed", ["--tenants", "2"])).rejects.toThrow(/provisioning paused 1 tenants .*Cloudflare API 400.*seed --run/);
    fake.platform.db.prepare("UPDATE tenants SET provision_paused_at = NULL WHERE provision_paused_at IS NOT NULL").run();
    const runId = readdirSync(join(root, ".hosted-drills")).find((f) => /^load-[a-z0-9]{4}\.json$/.test(f)).slice(5, 9);
    const state = await load("seed", ["--run", runId]);
    expect(state.seeded).toHaveLength(2);
  });

  it("reports the cost as not measured without the analytics token", async () => {
    const state = await load("seed", ["--tenants", "1"]);
    const report = await load("run", ["--run", state.runId, "--duration", "24m", "--warmup", "1m"], { [ANALYTICS_TOKEN_ENV]: "" });
    expect(report.verdict).toBe("incomplete");
    expect(logs.join("\n")).toMatch(/won't be measured/);
  });

  it("refuses production, and a seed without PLATFORM_KEY, before running anything", async () => {
    writeFileSync(configPath, JSON.stringify({ ...STAGING, d1_databases: [{ binding: "PLATFORM_DB", database_name: "openping-platform" }] }));
    await expect(load("seed")).rejects.toThrow(/isn't a staging name/);
    writeFileSync(configPath, JSON.stringify(STAGING));
    await expect(load("seed", [], { [PLATFORM_KEY_ENV]: "" })).rejects.toThrow(new RegExp(PLATFORM_KEY_ENV));
    expect(fake.log).toEqual([]);
  });

  it("plan prints the plan and every command, and runs none", async () => {
    await main(["plan", "--env", "staging", "--config", configPath], { run: fake.run, fetch: fake.fetch, log: (l) => logs.push(l), env: {}, now: fake.now, wait: fake.wait, root });
    expect(fake.log).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain("200 tenants");
    for (const what of ["# seed", "# run", "# cleanup", "wrangler deploy", "/__health", "graphql", "wrangler delete"]) expect(text).toContain(what);
    expect(text).not.toContain("—");
  });
});

describe("the load test's SQL against the real schemas", () => {
  it("seeds valid rows, removes them, and leaves nobody else's", async () => {
    const db = fake.platform.db;
    db.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_real', 'real@example.com', 0, 0)").run();
    db.prepare("INSERT INTO tenants (id, account_id, slug, script_name, created_at, updated_at) VALUES ('realtenant000001', 'acc_real', 'lt-real', 't-realtenant000001', 0, 0)").run();
    let n = 0;
    const tenants = loadTenants({ runId: "abcd", count: 3, newTenantId: () => `loadtenant${String(++n).padStart(6, "0")}` });
    db.exec(platformSeedSql(tenants, { now: 1 }));
    expect(db.prepare("SELECT slug FROM tenants WHERE slug LIKE 'lt-abcd-%' ORDER BY slug").all().map((r) => r.slug)).toEqual(["lt-abcd-001", "lt-abcd-002", "lt-abcd-003"]);
    db.prepare(markForRemovalSql("abcd", { now: 2 })).run();
    // A real customer whose slug happens to start with lt- is never touched.
    expect(db.prepare("SELECT provision_state FROM tenants WHERE id = 'realtenant000001'").get().provision_state).toBe("requested");
    expect(db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE provision_state = 'deleting'").get().n).toBe(3);
    db.exec("DELETE FROM lifecycle_notices WHERE tenant_id LIKE 'loadtenant%'; DELETE FROM tenants WHERE id LIKE 'loadtenant%'");
    db.exec(leftoversSql("abcd", tenants.map((t) => t.tenantId)));
    expect(db.prepare("SELECT id FROM accounts").all().map((r) => r.id)).toEqual(["acc_real"]);
  });

  it("refuses a malformed run id", () => {
    expect(() => loadTenants({ runId: "x'; DROP", count: 1, newTenantId: () => "a".repeat(16) })).toThrow();
    expect(() => markForRemovalSql("ABCD", { now: 1 })).toThrow();
  });
});
