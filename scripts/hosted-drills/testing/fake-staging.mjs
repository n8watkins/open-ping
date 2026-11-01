// A stand-in for a staging Cloudflare account, for the drills' tests: the
// Wrangler commands they run, the HTTPS requests they make, and the
// platform's every-minute cron, all in memory over real SQLite (node:sqlite)
// with the real migrations, so the drills run end to end without a network.
//
//   run(argv)   answers `wrangler d1 execute|info|create|delete`,
//               `wrangler r2 object get`, `wrangler deploy|delete` as
//               Wrangler does (JSON where --json), failing like it for a
//               database that doesn't exist
//   fetch(url)  the platform's /__health, the echo Worker, GraphQL Analytics
//   tick()      one minute of the platform: the provisioning sweep (as
//               platform/src/provisioning.ts, its tests cover the real one),
//               the lifecycle job's exports, and a scheduler run for every
//               ready tenant
//
// The drills' `wait` is wired to tick(), so every wait is a minute passing.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ROOT } from "../lib.mjs";
import { escrowMasterKey, generateMasterKey } from "../../../platform/src/keys.ts";

const MINUTE = 60_000;

/** Applies a migrations folder as `wrangler d1 migrations apply` does, recording each in d1_migrations. */
function applyMigrations(db, dir) {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-11-01 00:00:00')").run(f);
  }
}

/** Splits SQL on the semicolons outside quotes. */
export function splitStatements(sql) {
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const literal = (v) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** A D1-style SQL dump of a database: its tables with their rows, then indexes and triggers. */
export function dumpDatabase(db) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid").all();
  for (const o of objects) {
    lines.push(`${o.sql};`);
    if (o.type !== "table") continue;
    for (const row of db.prepare(`SELECT * FROM "${o.name}"`).all()) lines.push(`INSERT INTO "${o.name}" VALUES(${Object.values(row).map(literal).join(",")});`);
  }
  return lines.join("\n") + "\n";
}

export class FakeStaging {
  constructor({ root = ROOT, platformKey = generateMasterKey(), now = Date.UTC(2026, 10, 2, 9, 0, 0), platformDb = "openping-platform-staging", exportsBucket = "openping-tenant-exports-staging" } = {}) {
    this.root = root;
    this.platformKey = platformKey;
    this.clock = { now };
    this.platformDbName = platformDb;
    this.exportsBucket = exportsBucket;
    this.databases = new Map();
    this.objects = new Map();
    this.workers = new Set();
    /** Every command run and every request made, in order. */
    this.log = [];
    /** Uploads the fake provisioning made: { tenantId, d1Id, masterKey }. */
    this.uploads = [];
    /** Injected failures: a predicate on argv (or a substring of it) -> message, used once each. */
    this.failures = new Map();
    this.health = { status: 200, body: { ok: true, checks: { database: true, cron: true, queue: true, scheduler: true, tenants: true, release: true, config: true } } };
    this.lagMs = () => 4_000;
    this.platform = this.#createDatabase(platformDb, { migrations: resolve(ROOT, "platform/migrations"), foreignKeys: true });
  }

  now = () => this.clock.now;

  #createDatabase(name, { migrations = null, foreignKeys = false } = {}) {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: foreignKeys });
    if (migrations) applyMigrations(db, migrations);
    const entry = { uuid: randomUUID(), name, db };
    this.databases.set(name, entry);
    return entry;
  }

  /** A tenant DB the way provisioning leaves one: OpenPing's migrations applied. */
  createTenantDatabase(name) {
    return this.#createDatabase(name, { migrations: resolve(ROOT, "migrations") });
  }

  /** A ready tenant with its escrowed key and its database (what a real sign-up ends with). */
  async addReadyTenant({ slug, tenantId = randomUUID().replace(/-/g, "").slice(0, 16), accountId = `acc_${slug}` }) {
    const now = this.now();
    const masterKey = generateMasterKey();
    const escrowed = await escrowMasterKey(masterKey, tenantId, this.platformKey);
    const tdb = this.createTenantDatabase(`openping-t-${tenantId}`);
    const p = this.platform.db;
    p.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(accountId, `${slug}@example.com`, now, now);
    p.prepare("INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, d1_id, version, provisioned_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'hosted', 'ready', ?, '0.18.0', ?, ?, ?)").run(
      tenantId,
      accountId,
      slug,
      `t-${tenantId}`,
      tdb.uuid,
      now,
      now,
      now,
    );
    p.prepare("INSERT INTO escrowed_keys (tenant_id, kid, ciphertext, created_at) VALUES (?, ?, ?, ?)").run(tenantId, escrowed.kid, escrowed.ciphertext, now);
    return { tenantId, accountId, masterKey, db: tdb.db };
  }

  tenant(slug) {
    return this.platform.db.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug);
  }

  // --- Wrangler -------------------------------------------------------------------

  run = (argv) => {
    this.log.push({ kind: "run", argv });
    const text = argv.join(" ");
    for (const [needle, message] of this.failures) {
      if (typeof needle === "function" ? needle(argv) : text.includes(needle)) {
        this.failures.delete(needle);
        return { status: 1, stdout: "", stderr: message };
      }
    }
    const [npx, wrangler, group, verb] = argv;
    if (npx !== "npx" || wrangler !== "wrangler") return { status: 127, stdout: "", stderr: "not wrangler" };
    const flag = (name) => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    const missing = (name) => ({ status: 1, stdout: "", stderr: `Couldn't find a D1 DB with name or binding '${name}' in your config or the API.` });
    if (group === "d1") {
      const name = argv[4];
      const entry = this.databases.get(name);
      switch (verb) {
        case "execute": {
          if (!argv.includes("--remote")) return { status: 1, stdout: "", stderr: "the drills only use --remote" };
          if (!entry) return missing(name);
          if (flag("--file")) {
            entry.db.exec(readFileSync(resolve(this.root, flag("--file")), "utf8"));
            return { status: 0, stdout: JSON.stringify([{ results: [], success: true, meta: {} }]), stderr: "" };
          }
          const results = splitStatements(flag("--command")).map((sql) => {
            const stmt = entry.db.prepare(sql);
            if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { results: stmt.all().map((r) => ({ ...r })), success: true, meta: {} };
            const info = stmt.run();
            return { results: [], success: true, meta: { changes: Number(info.changes) } };
          });
          return { status: 0, stdout: `banner\n${JSON.stringify(results)}`, stderr: "" };
        }
        case "info":
          return entry ? { status: 0, stdout: JSON.stringify({ uuid: entry.uuid, name: entry.name, num_tables: 1 }), stderr: "" } : missing(name);
        case "create":
          if (entry) return { status: 1, stdout: "", stderr: "A database with that name already exists" };
          this.#createDatabase(name);
          return { status: 0, stdout: `Created ${name}`, stderr: "" };
        case "delete":
          if (!entry) return missing(name);
          this.databases.delete(name);
          return { status: 0, stdout: `Deleted ${name}`, stderr: "" };
      }
    }
    if (group === "r2" && verb === "object" && argv[4] === "get") {
      const body = this.objects.get(argv[5]);
      if (!body) return { status: 1, stdout: "", stderr: "The specified key does not exist." };
      writeFileSync(resolve(this.root, flag("--file")), body);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (group === "deploy") {
      this.workers.add("openping-loadtest-echo-staging");
      return { status: 0, stdout: "Uploaded openping-loadtest-echo-staging\n  https://openping-loadtest-echo-staging.fake.workers.dev\n", stderr: "" };
    }
    if (group === "delete") {
      this.workers.delete("openping-loadtest-echo-staging");
      return { status: 0, stdout: "Successfully deleted", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `the fake doesn't know ${text}` };
  };

  // --- HTTPS ------------------------------------------------------------------------

  fetch = async (url, init = {}) => {
    this.log.push({ kind: "http", url, method: init.method ?? "GET", headers: init.headers ?? {} });
    const u = new URL(url);
    if (u.pathname === "/__health") return new Response(JSON.stringify(this.health.body), { status: this.health.status });
    if (u.hostname.endsWith(".workers.dev")) return new Response("ok\n", { status: u.pathname === "/ok" ? 200 : 404 });
    if (u.hostname === "api.cloudflare.com" && u.pathname.endsWith("/graphql")) return new Response(JSON.stringify(this.graphql(JSON.parse(init.body))), { status: 200 });
    return new Response("not found", { status: 404 });
  };

  /** GraphQL Analytics: fixed usage per database and script, so the report's math can be checked. */
  graphql({ variables }) {
    return {
      data: {
        viewer: {
          accounts: [
            {
              // Each tenant database 1,000 rows each way in the window; the platform's 30 per tenant.
              d1: variables.databases.map((databaseId) =>
                databaseId === this.platform.uuid
                  ? { dimensions: { databaseId }, sum: { rowsRead: 30 * (variables.databases.length - 1), rowsWritten: 30 * (variables.databases.length - 1), readQueries: 5, writeQueries: 5 } }
                  : { dimensions: { databaseId }, sum: { rowsRead: 1_000, rowsWritten: 1_000, readQueries: 50, writeQueries: 50 } },
              ),
              workers: variables.scripts.map((scriptName) => ({ dimensions: { scriptName }, sum: { requests: 6, errors: 0 }, quantiles: { cpuTimeP50: 8_000, cpuTimeP99: 20_000 } })),
            },
          ],
        },
      },
    };
  }

  // --- The platform's minute ----------------------------------------------------------

  /** The drills' wait: a minute passes and the platform's cron runs. */
  wait = async (ms) => {
    this.clock.now += Math.max(ms, MINUTE);
    await this.tick();
  };

  async tick() {
    await this.#provision();
    this.#exports();
    this.#schedule();
  }

  async #provision() {
    const p = this.platform.db;
    const now = this.now();
    const due = p.prepare("SELECT * FROM tenants WHERE provision_state <> 'ready' AND provision_paused_at IS NULL ORDER BY created_at LIMIT 10").all();
    for (const t of due) {
      if (t.provision_state === "deleting") {
        const name = `openping-t-${t.id}`;
        this.databases.delete(name);
        p.prepare("DELETE FROM escrowed_keys WHERE tenant_id = ?").run(t.id);
        if (t.provisioned_at !== null) p.prepare("INSERT OR REPLACE INTO slug_holds (slug, held_until, reason) VALUES (?, ?, 'deleted')").run(t.slug, now + 90 * 86_400_000);
        p.prepare("INSERT INTO audit_events (at, tenant_id, actor, action) VALUES (?, ?, 'system', 'tenant.removed')").run(now, t.id);
        p.prepare("DELETE FROM tenants WHERE id = ?").run(t.id);
        continue;
      }
      let key = p.prepare("SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ? AND retired_at IS NULL").get(t.id);
      if (!key) {
        const escrowed = await escrowMasterKey(generateMasterKey(), t.id, this.platformKey);
        p.prepare("INSERT INTO escrowed_keys (tenant_id, kid, ciphertext, created_at) VALUES (?, ?, ?, ?)").run(t.id, escrowed.kid, escrowed.ciphertext, now);
        key = escrowed;
      }
      let d1Id = t.d1_id;
      if (t.provision_state === "requested") d1Id = this.createTenantDatabase(`openping-t-${t.id}`).uuid;
      const bound = [...this.databases.values()].find((d) => d.uuid === d1Id);
      if (!bound) {
        p.prepare("UPDATE tenants SET provision_paused_at = ?, provision_error = 'the d1 binding names no database' WHERE id = ?").run(now, t.id);
        continue;
      }
      this.uploads.push({ tenantId: t.id, d1Id, kid: key.kid });
      p.prepare("UPDATE tenants SET provision_state = 'ready', d1_id = ?, version = '0.18.0', provisioned_at = ?, provision_attempts = 0, updated_at = ? WHERE id = ?").run(d1Id, now, now, t.id);
    }
  }

  #exports() {
    const p = this.platform.db;
    const now = this.now();
    for (const e of p.prepare("SELECT * FROM tenant_exports WHERE state IN ('requested', 'exporting')").all()) {
      const t = p.prepare("SELECT d1_id FROM tenants WHERE id = ?").get(e.tenant_id);
      const entry = [...this.databases.values()].find((d) => d.uuid === t?.d1_id);
      if (!entry) {
        p.prepare("UPDATE tenant_exports SET state = 'failed', error = 'the tenant has no database' WHERE id = ?").run(e.id);
        continue;
      }
      const dump = Buffer.from(dumpDatabase(entry.db));
      const prefix = `exports/${e.tenant_id}/${e.id}/`;
      this.objects.set(`${this.exportsBucket}/${prefix}openping.sql`, dump);
      const key = p.prepare("SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ? AND retired_at IS NULL").get(e.tenant_id);
      p.prepare("INSERT INTO export_keys (export_id, tenant_id, kid, ciphertext) VALUES (?, ?, ?, ?)").run(e.id, e.tenant_id, key.kid, key.ciphertext);
      p.prepare("UPDATE tenant_exports SET state = 'done', r2_prefix = ?, bytes = ?, sha256 = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
        prefix,
        dump.byteLength,
        createHash("sha256").update(dump).digest("hex"),
        now,
        now,
        e.id,
      );
    }
  }

  #schedule() {
    const p = this.platform.db;
    const now = this.now();
    const ready = p.prepare("SELECT id, d1_id, schedule_next_at FROM tenants WHERE provision_state = 'ready' AND provision_paused_at IS NULL AND schedule_next_at <= ?").all(now);
    const minute = Math.floor(now / MINUTE);
    let runs = 0;
    let lagTotal = 0;
    let lagMax = 0;
    for (const t of ready) {
      const entry = [...this.databases.values()].find((d) => d.uuid === t.d1_id);
      const checked = entry ? Number(entry.db.prepare("SELECT COUNT(*) AS n FROM monitors").get().n) : 0;
      const lag = this.lagMs(t.id);
      const runId = `run_${randomUUID()}`;
      p.prepare(
        `INSERT INTO scheduler_stats (tenant_id, last_run_id, last_at, last_outcome, last_duration_ms, last_tenant_ms, last_lag_ms, last_checked, last_failures, last_deferred, last_d1_queries, last_version, last_ok_at, streak, day, day_runs, day_errors, day_checked, day_failures, day_d1_queries, day_ms, day_max_ms)
         VALUES (?, ?, ?, ?, 900, 700, ?, ?, 1, 0, 6, '0.18.0', ?, 0, ?, 1, 0, ?, 1, 6, 900, 900)
         ON CONFLICT(tenant_id) DO UPDATE SET last_run_id = excluded.last_run_id, last_at = excluded.last_at, last_outcome = excluded.last_outcome, last_lag_ms = excluded.last_lag_ms, last_checked = excluded.last_checked, day_runs = day_runs + 1`,
      ).run(t.id, runId, now, entry ? "ran" : "failed", lag, checked, now, Math.floor(now / 86_400_000), checked);
      p.prepare("UPDATE tenants SET schedule_next_at = ? WHERE id = ?").run(now + 12 * MINUTE, t.id);
      runs++;
      lagTotal += lag;
      lagMax = Math.max(lagMax, lag);
    }
    if (runs) {
      p.prepare(
        `INSERT INTO scheduler_minutes (minute, runs, errors, timeouts, busy, checked, failures, total_ms, max_ms, lag_total_ms, lag_max_ms) VALUES (?, ?, 0, 0, 0, 0, 0, ?, 900, ?, ?)
         ON CONFLICT(minute) DO UPDATE SET runs = runs + excluded.runs`,
      ).run(minute, runs, runs * 900, lagTotal, lagMax);
    }
  }
}
