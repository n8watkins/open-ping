#!/usr/bin/env node
// `npm run hosted-restore-drill -- --env staging --config <staging platform config> --tenant <slug> [--confirm <name>] [--dry-run | --print]`
//
// The restore drill of the Hosted build plan (docs/HOSTED_BUILD_PLAN.md,
// section 9): take a staging tenant's database away and bring it back from
// its export with its escrowed key, proving the data and the encrypted
// settings read back. The runbook is docs/hosted/LAUNCH_DRILLS.md.
//
// The steps, in order (STEPS), each saved to a state file before the next:
//
//   preflight          the tenant is ready, nothing else is working on it, its
//                      escrowed MASTER_KEY opens with PLATFORM_KEY, and its
//                      database has encrypted values to prove anything with
//   quiesce            takes it off the air: provisioning state db_created,
//                      paused, so the platform neither routes to it nor runs
//                      its scheduler; waits out a run in flight
//   fingerprint-before every table's rows, the key tables' checksums, and the
//                      hash of every encrypted value decrypted
//   export             asks the platform for an export (tenant_exports), the
//                      same one a deletion and a customer use, and waits for it
//   download           the dump from R2, checked against the export's SHA-256,
//                      and the key kept with the export opened
//   delete-database    deletes the tenant's D1 database
//   create-database    creates it again under the same name (a new id)
//   import             loads the dump into it
//   fingerprint-after  must equal fingerprint-before
//   rebind             records the new database id and unpauses: the
//                      platform's provisioning uploads the tenant again,
//                      bound to it, with the escrowed MASTER_KEY
//   wait-ready         provisioning reaches ready again
//   wait-run           one scheduled run comes back `ran`
//   verify-live        the encrypted values still decrypt after that run
//
// Until delete-database, a failure puts the tenant back as it was. After it,
// the drill stops and says how to continue (--continue <state file>).
//
// It works the same with or without Workers for Platforms: the upload is
// whatever the platform's provisioning does in db_created.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DrillError,
  ROOT,
  STATE_DIR,
  assertStaging,
  d1Create,
  d1Delete,
  d1File,
  d1Info,
  d1InfoId,
  d1Query,
  d1Results,
  d1Rows,
  makeExecutor,
  modeOf,
  parseArgs,
  platformResources,
  r2Get,
  readConfig,
  sha256Hex,
  sleep,
  sqlValue,
  stamp,
  waitFor,
} from "./lib.mjs";
import { isValidKey, openEscrowedKey } from "./keys.mjs";
import { exportRequestSql, exportStatusSql, quiesceSql, rebindSql, tenantLookupSql, unquiesceSql } from "./restore-sql.mjs";
import { KEY_TABLES, STABLE_TABLES, TABLES_SQL, compareFingerprints, countsSql, fingerprintTotals, primaryKeyOf, rowsSql, tableFingerprint, tableInfoSql } from "./fingerprint.mjs";

export const STEPS = [
  "preflight",
  "quiesce",
  "fingerprint-before",
  "export",
  "download",
  "delete-database",
  "create-database",
  "import",
  "fingerprint-after",
  "rebind",
  "wait-ready",
  "wait-run",
  "verify-live",
];


export const PLATFORM_KEY_ENV = "OPENPING_PLATFORM_KEY";
const PAGE = 1000;

export const TIMING = {
  pollMs: 15_000,
  /** The platform's route cache keeps a ready tenant 30 seconds per isolate (platform/src/tenants.ts). */
  routeCacheMs: 35_000,
  leaseTimeoutMs: 5 * 60_000,
  /** The lifecycle cron works on exports every 5 minutes. */
  exportTimeoutMs: 25 * 60_000,
  readyTimeoutMs: 20 * 60_000,
  runTimeoutMs: 20 * 60_000,
};

const placeholder = (what) => `<${what}>`;
const tenantDb = (tenantId) => `openping-t-${tenantId}`;

// --- Fingerprints -------------------------------------------------------------------

/** The fingerprint of `database` (fingerprint.mjs), or null when the mode didn't read it. */
export async function fingerprintDatabase(ctx, database, masterKey, { keyTables = KEY_TABLES } = {}) {
  const listed = await ctx.exec(d1Query(ctx, database, TABLES_SQL, { what: `list the tables of ${database}` }));
  if (!listed) {
    await ctx.exec(d1Query(ctx, database, countsSql(["monitors"]), { what: "count every table's rows (one statement per table)" }));
    await ctx.exec(d1Query(ctx, database, rowsSql("monitors", ["id"], { limit: PAGE, offset: 0 }), { what: `read each key table in pages of ${PAGE}, in primary key order (${keyTables.join(", ")})` }));
    return null;
  }
  const tables = d1Rows(listed).map((r) => r.name);
  const counts = {};
  if (tables.length) {
    const answer = await ctx.exec(d1Query(ctx, database, countsSql(tables), { what: `count the rows of ${tables.length} tables` }));
    for (const rows of d1Results(answer)) for (const r of rows) counts[r.name] = r.n;
  }
  const present = keyTables.filter((t) => tables.includes(t));
  const fingerprints = {};
  if (present.length) {
    const info = d1Results(await ctx.exec(d1Query(ctx, database, tableInfoSql(present), { what: "read the key tables' primary keys" })));
    for (const [i, table] of present.entries()) {
      const pk = primaryKeyOf(info[i] ?? []);
      const rows = [];
      for (let offset = 0; offset < (counts[table] ?? 0); offset += PAGE) {
        rows.push(...d1Rows(await ctx.exec(d1Query(ctx, database, rowsSql(table, pk, { limit: PAGE, offset }), { what: `read ${table} rows ${offset + 1} to ${offset + PAGE}` }))));
      }
      fingerprints[table] = await tableFingerprint(rows, { masterKey, sha256Hex });
    }
  }
  return { counts, tables: fingerprints };
}

// --- The steps ------------------------------------------------------------------------

/** The dump without statements on D1's own `_cf_` tables (one statement a line, as D1's dumps are). */
export function importableDump(text) {
  const own = /^\s*(CREATE TABLE|INSERT INTO|CREATE INDEX|CREATE UNIQUE INDEX)\s+(IF NOT EXISTS\s+)?["'`[]?_cf_/i;
  return text
    .split("\n")
    .filter((line) => !own.test(line))
    .join("\n");
}

/** Opens the tenant's escrowed key with PLATFORM_KEY, from the environment. Never logged. */
async function openKey(ctx, escrowed, tenantId) {
  const platformKey = ctx.env[PLATFORM_KEY_ENV];
  if (!isValidKey(platformKey)) throw new DrillError(`${PLATFORM_KEY_ENV} must hold the staging platform's PLATFORM_KEY (32 bytes, base64), from the password manager`);
  try {
    return await openEscrowedKey(escrowed, tenantId, platformKey);
  } catch (error) {
    throw new DrillError(`the escrowed MASTER_KEY doesn't open: ${error.message}`);
  }
}

/** Reads the tenant and opens its key: what every step needs, including on --continue. */
async function loadTenant(ctx, { requireReady }) {
  ctx.loaded = true;
  const answer = await ctx.exec(d1Query(ctx, ctx.platformDb, tenantLookupSql(ctx.slug), { what: `look up tenant ${ctx.slug}, its escrowed key, and anything else working on it` }));
  if (!answer) {
    ctx.state.tenant ??= { id: placeholder("tenant id"), accountId: placeholder("account id"), slug: ctx.slug, d1Id: placeholder("database id") };
    return;
  }
  const [[tenant], [escrowed], [releases], [exportsOpen]] = d1Results(answer);
  if (!tenant) throw new DrillError(`no tenant ${ctx.slug} in ${ctx.platformDb}`);
  if (requireReady) {
    if (tenant.provision_state !== "ready" || tenant.provision_paused_at !== null) throw new DrillError(`${ctx.slug} isn't ready (${tenant.provision_state}${tenant.provision_paused_at !== null ? ", paused" : ""}); the drill starts from a working tenant`);
    if (tenant.status === "suspended" || tenant.owner_suspended_at !== null) throw new DrillError(`${ctx.slug} is suspended; pick a tenant that runs`);
    if (releases.n > 0) throw new DrillError("a release is in progress; run the drill when it is done (npm run tenant-release -- status)");
    if (exportsOpen.n > 0) throw new DrillError(`${ctx.slug} already has an export running; wait for it`);
  }
  if (!escrowed) throw new DrillError(`${ctx.slug} has no active escrowed key`);
  ctx.masterKey = await openKey(ctx, escrowed, tenant.id);
  ctx.state.tenant ??= { id: tenant.id, accountId: tenant.account_id, slug: tenant.slug, d1Id: tenant.d1_id, version: tenant.version };
  ctx.state.kid = escrowed.kid;
  ctx.current = tenant;
}

const steps = {
  async preflight(ctx) {
    await loadTenant(ctx, { requireReady: true });
    const { id, d1Id } = ctx.state.tenant;
    const info = await ctx.exec(d1Info(ctx, tenantDb(id), { what: "check the tenant's database by name" }));
    if (info) {
      if (info.failed || d1InfoId(info) !== d1Id) throw new DrillError(`${tenantDb(id)} isn't the database the tenant row names (${d1Id}); refusing to touch it`);
    }
    // Something to prove: the database must hold values sealed with this key.
    const probe = await fingerprintDatabase(ctx, tenantDb(id), ctx.masterKey);
    if (probe) {
      const totals = fingerprintTotals(probe);
      if (totals.decrypted === 0) throw new DrillError(`${ctx.slug} has no encrypted values to prove a restore with; add a monitor (its config is sealed) and run again`);
      if (totals.undecryptable) throw new DrillError(`${totals.undecryptable} encrypted values in ${ctx.slug} don't open with its escrowed key before the drill even starts; fix that first`);
      const foreign = totals.kids.filter((k) => k !== ctx.state.kid);
      if (foreign.length) throw new DrillError(`${ctx.slug} has values sealed with another key (${foreign.join(", ")}); rotate fully before the drill`);
      ctx.log(`  ${ctx.slug}: ${Object.keys(probe.counts).length} tables, ${totals.decrypted} encrypted values that open with key ${ctx.state.kid}`);
    }
  },

  async quiesce(ctx) {
    const { id } = ctx.state.tenant;
    const at = ctx.now();
    ctx.state.quiescedAt = at;
    const note = `restore drill ${stamp(at)}: paused while its database is restored (docs/hosted/LAUNCH_DRILLS.md)`;
    const answer = await ctx.exec(
      d1Query(
        ctx,
        ctx.platformDb,
        quiesceSql(id, { at, note }),
        { write: true, what: "take the tenant off the air: not routed, not scheduled, provisioning paused" },
      ),
    );
    if (!answer) return;
    const [row] = d1Results(answer)[1] ?? [];
    if (row?.provision_state !== "db_created" || row?.provision_paused_at !== at) throw new DrillError("the tenant changed under the drill; nothing was paused");
    // Wait out a scheduler run in flight and the platform's route cache.
    await waitFor(
      async () => {
        const [lease] = d1Rows(await ctx.exec(d1Query(ctx, ctx.platformDb, `SELECT schedule_lease_until AS until FROM tenants WHERE id = ${sqlValue(id)}`, { what: "check no scheduler run holds the tenant" })));
        const now = ctx.now();
        return (lease?.until ?? 0) < now && now - at >= TIMING.routeCacheMs ? true : undefined;
      },
      { everyMs: 5_000, timeoutMs: TIMING.leaseTimeoutMs, what: "the scheduler run in flight and the route cache", now: ctx.now, wait: ctx.wait, log: ctx.log },
    );
  },

  async "fingerprint-before"(ctx) {
    const fp = await fingerprintDatabase(ctx, tenantDb(ctx.state.tenant.id), ctx.masterKey);
    if (fp) ctx.state.before = fp;
  },

  async export(ctx) {
    const { id, accountId, slug } = ctx.state.tenant;
    const exportId = ctx.state.exportId ?? `exp_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    ctx.state.exportId = exportId;
    const at = ctx.now();
    const asked = await ctx.exec(
      d1Query(
        ctx,
        ctx.platformDb,
        exportRequestSql({ exportId, tenantId: id, accountId, slug, at }),
        { write: true, what: "ask the platform for an export of the tenant's database (its lifecycle job runs it within 5 minutes)" },
      ),
    );
    const poll = d1Query(
      ctx,
      ctx.platformDb,
      exportStatusSql(exportId),
      { what: "check the export" },
    );
    if (!asked) {
      await ctx.exec(poll);
      return;
    }
    const done = await waitFor(
      async () => {
        const [[row], [key]] = d1Results(await ctx.exec(poll));
        if (row?.state === "failed") throw new DrillError(`the export failed: ${row.error ?? "no reason"}`);
        if (row?.state === "done") return { row, key };
        return undefined;
      },
      { everyMs: TIMING.pollMs, timeoutMs: TIMING.exportTimeoutMs, what: `export ${exportId}`, now: ctx.now, wait: ctx.wait, log: ctx.log },
    );
    if (!done.key) throw new DrillError("the export is done but its key wasn't kept with it");
    ctx.state.export = { prefix: done.row.r2_prefix, bytes: done.row.bytes, sha256: done.row.sha256, kid: done.key.kid, keyCiphertext: done.key.ciphertext, seconds: Math.round((ctx.now() - at) / 1000) };
  },

  async download(ctx) {
    const exp = ctx.state.export ?? { prefix: `exports/${ctx.state.tenant.id}/${ctx.state.exportId ?? placeholder("export id")}/` };
    const file = join(ctx.stateDir, `restore-${ctx.state.tenant.id}-${ctx.state.exportId ?? "export"}.sql`);
    const got = await ctx.exec(r2Get(ctx, ctx.exportsBucket, `${exp.prefix}openping.sql`, relative(ctx.root, file), { what: "download the export's dump" }));
    if (got === null) return;
    chmodSync(file, 0o600);
    const bytes = readFileSync(file);
    if (bytes.byteLength !== exp.bytes || (await sha256Hex(bytes)) !== exp.sha256) throw new DrillError("the downloaded dump doesn't match the export's size and SHA-256");
    const text = bytes.toString("utf8");
    for (const table of ["d1_migrations", "monitors"]) if (!new RegExp(`CREATE TABLE\\s+["'\`[]?${table}\\b`, "i").test(text)) throw new DrillError(`the dump has no ${table} table`);
    // "With its escrowed key": the copy kept with the export must be the tenant's key.
    const exportKey = await openKey(ctx, { kid: exp.kid, ciphertext: exp.keyCiphertext }, ctx.state.tenant.id);
    if (exportKey !== ctx.masterKey) throw new DrillError("the key kept with the export isn't the tenant's escrowed key");
    // What D1 keeps for itself (_cf_ tables) can't be created by a query, so the copy loaded leaves it out.
    const importable = importableDump(text);
    if (importable !== text) writeFileSync(file, importable, { mode: 0o600 });
    ctx.state.dumpFile = relative(ctx.root, file);
  },

  async "delete-database"(ctx) {
    const name = tenantDb(ctx.state.tenant.id);
    const info = await ctx.exec(d1Info(ctx, name, { what: "check once more which database is about to be deleted" }));
    if (info && (info.failed || d1InfoId(info) !== ctx.state.tenant.d1Id)) {
      // Deleted already, by a run of this drill that stopped right after.
      if (info.failed && ctx.state.completed.includes("download")) {
        ctx.log(`  ${name} is already gone`);
        return;
      }
      throw new DrillError(`${name} isn't ${ctx.state.tenant.d1Id} any more; refusing to delete it`);
    }
    ctx.state.deletedAt = ctx.now();
    await ctx.exec(d1Delete(ctx, name, { what: "delete the tenant's database" }));
  },

  async "create-database"(ctx) {
    const name = tenantDb(ctx.state.tenant.id);
    const before = await ctx.exec(d1Info(ctx, name, { what: "check the name is free" }));
    if (before && !before.failed) {
      const id = d1InfoId(before);
      if (id === ctx.state.tenant.d1Id) throw new DrillError(`${name} still has its old id; the delete didn't take`);
      ctx.state.newD1Id = id;
      ctx.log(`  ${name} exists already (${id}), made by an earlier run of this drill`);
      return;
    }
    await ctx.exec(d1Create(ctx, name, { what: "create the tenant's database again, under the same name" }));
    const after = await ctx.exec(d1Info(ctx, name, { what: "read the new database's id" }));
    if (after === null) return;
    if (after.failed || !d1InfoId(after)) throw new DrillError(`${name} wasn't created`);
    ctx.state.newD1Id = d1InfoId(after);
  },

  async import(ctx) {
    const name = tenantDb(ctx.state.tenant.id);
    const listed = await ctx.exec(d1Query(ctx, name, TABLES_SQL, { what: "check the new database is empty" }));
    if (listed && d1Rows(listed).length) {
      const fp = await fingerprintDatabase(ctx, name, ctx.masterKey);
      if (compareFingerprints(ctx.state.before, fp).length === 0) {
        ctx.log("  the dump is already loaded");
        return;
      }
      throw new DrillError(`${name} isn't empty and doesn't match the export; delete it and --continue`);
    }
    await ctx.exec(d1File(ctx, name, ctx.state.dumpFile ?? `${STATE_DIR}/${placeholder("the dump")}`, { what: "load the dump into it" }));
  },

  async "fingerprint-after"(ctx) {
    const fp = await fingerprintDatabase(ctx, tenantDb(ctx.state.tenant.id), ctx.masterKey);
    if (!fp) return;
    const problems = compareFingerprints(ctx.state.before, fp);
    if (problems.length) throw new DrillError(`the restored database doesn't match the one deleted:\n  - ${problems.join("\n  - ")}`);
    ctx.state.after = fp;
  },

  async rebind(ctx) {
    const { id } = ctx.state.tenant;
    const at = ctx.now();
    const answer = await ctx.exec(
      d1Query(
        ctx,
        ctx.platformDb,
        rebindSql(id, { d1Id: ctx.state.newD1Id ?? placeholder("new database id"), quiescedAt: ctx.state.quiescedAt ?? 0, now: at }),
        { write: true, what: "point the tenant at the new database and let provisioning upload it again (with its escrowed MASTER_KEY)" },
      ),
    );
    if (!answer) return;
    const [row] = d1Results(answer)[1] ?? [];
    if (row?.d1_id !== ctx.state.newD1Id || row?.provision_paused_at !== null) throw new DrillError("the tenant row didn't take the new database; check it in the admin console");
    ctx.state.reboundAt = at;
  },

  async "wait-ready"(ctx) {
    const poll = d1Query(ctx, ctx.platformDb, `SELECT provision_state, provision_paused_at, provision_error, d1_id, version FROM tenants WHERE id = ${sqlValue(ctx.state.tenant.id)}`, { what: "check provisioning" });
    if (!ctx.exec.writes) {
      await ctx.exec(poll);
      return;
    }
    const row = await waitFor(
      async () => {
        const [r] = d1Rows(await ctx.exec(poll));
        if (r?.provision_paused_at !== null && r?.provision_paused_at !== undefined) throw new DrillError(`provisioning paused: ${r.provision_error ?? "no reason"} (admin console: resume it once fixed, then --continue)`);
        return r?.provision_state === "ready" && r.d1_id === ctx.state.newD1Id ? r : undefined;
      },
      { everyMs: TIMING.pollMs, timeoutMs: TIMING.readyTimeoutMs, what: "the tenant to be ready again", now: ctx.now, wait: ctx.wait, log: ctx.log },
    );
    ctx.state.readyAt = ctx.now();
    ctx.state.versionAfter = row.version;
  },

  async "wait-run"(ctx) {
    const poll = d1Query(ctx, ctx.platformDb, `SELECT last_at, last_outcome, last_error, last_checked FROM scheduler_stats WHERE tenant_id = ${sqlValue(ctx.state.tenant.id)}`, { what: "check the tenant's last scheduled run" });
    if (!ctx.exec.writes) {
      await ctx.exec(poll);
      return;
    }
    const since = ctx.state.reboundAt ?? 0;
    const run = await waitFor(
      async () => {
        const [r] = d1Rows(await ctx.exec(poll));
        if (!r || r.last_at < since) return undefined;
        if (r.last_outcome === "ran") return r;
        if (r.last_outcome !== "lease_busy") throw new DrillError(`the first scheduled run after the restore answered ${r.last_outcome}: ${r.last_error ?? "no reason"}`);
        return undefined;
      },
      { everyMs: TIMING.pollMs, timeoutMs: TIMING.runTimeoutMs, what: "a scheduled run on the restored database", now: ctx.now, wait: ctx.wait, log: ctx.log },
    );
    ctx.state.firstRun = { at: run.last_at, checked: run.last_checked };
  },

  async "verify-live"(ctx) {
    const fp = await fingerprintDatabase(ctx, tenantDb(ctx.state.tenant.id), ctx.masterKey, { keyTables: STABLE_TABLES });
    if (!fp) return;
    const problems = [];
    for (const table of STABLE_TABLES) {
      const a = ctx.state.before.tables[table];
      const b = fp.tables[table];
      if (!a) continue;
      if (!b) problems.push(`${table} is gone`);
      else {
        if (b.undecryptable) problems.push(`${table}: ${b.undecryptable} encrypted values don't open`);
        // A newer bundle may have added columns, so rows are compared by count and by their decrypted values.
        if (table !== "d1_migrations" && a.rows !== b.rows) problems.push(`${table}: ${a.rows} rows before, ${b.rows} now`);
        if (a.decryptedSha256 !== b.decryptedSha256) problems.push(`${table}: the decrypted values changed`);
      }
    }
    if (problems.length) throw new DrillError(`after its first run, the restored tenant doesn't read back:\n  - ${problems.join("\n  - ")}`);
  },
};

/** Puts a quiesced tenant back as it was, when the drill stops before its database is deleted. */
async function unquiesce(ctx) {
  const { id } = ctx.state.tenant;
  await ctx.exec(
    d1Query(
      ctx,
      ctx.platformDb,
      unquiesceSql(id, { quiescedAt: ctx.state.quiescedAt, now: ctx.now() }),
      { write: true, what: "put the tenant back on the air (the drill stopped before deleting anything)" },
    ),
  );
}

// --- The command ---------------------------------------------------------------------------

function latestState(stateDir, slug) {
  if (!existsSync(stateDir)) return null;
  const files = readdirSync(stateDir).filter((f) => f.startsWith(`restore-${slug}-`) && f.endsWith(".json")).sort();
  return files.length ? join(stateDir, files.at(-1)) : null;
}

export function summary(state) {
  const lines = [`Restore drill of ${state.tenant.slug}: ${state.result ?? "in progress"}.`];
  if (state.before) {
    const t = fingerprintTotals(state.before);
    lines.push(`- ${Object.keys(state.before.counts).length} tables and ${Object.values(state.before.counts).reduce((a, b) => a + b, 0)} rows read back identical; ${t.decrypted} encrypted values decrypt to the same hashes with key ${state.kid}.`);
  }
  if (state.export) lines.push(`- The export took ${state.export.seconds} s (${state.export.bytes} bytes, SHA-256 ${state.export.sha256.slice(0, 12)}...).`);
  if (state.deletedAt && state.readyAt) lines.push(`- From deleting the database to the tenant being ready again: ${Math.round((state.readyAt - state.deletedAt) / 1000)} s; off the air for ${Math.round((state.readyAt - state.quiescedAt) / 1000)} s.`);
  if (state.firstRun) lines.push(`- Its first scheduled run after the restore checked ${state.firstRun.checked} monitors.`);
  if (state.versionAfter && state.tenant.version && state.versionAfter !== state.tenant.version) lines.push(`- It now runs ${state.versionAfter} (it ran ${state.tenant.version}): provisioning uploads the current bundle.`);
  return lines.join("\n");
}

export async function main(argv, { run, fetch, log = console.log, env = process.env, now = Date.now, wait = sleep, root = ROOT } = {}) {
  const { flags } = parseArgs(argv, ["dry-run", "print", "keep-dump", "help"]);
  if (flags.help) {
    log(
      [
        "npm run hosted-restore-drill -- --env staging --config <staging platform config> --tenant <slug> [options]",
        "  --confirm <name>     the staging platform Worker's name, required for a run that changes anything",
        "  --dry-run            run the read-only steps, print the rest",
        "  --print              print every remote command, run nothing",
        "  --continue <file>    go on from a stopped drill's state file",
        "  --keep-dump          keep the downloaded dump in .hosted-drills/ afterwards",
        `Needs ${PLATFORM_KEY_ENV} (the staging PLATFORM_KEY) except with --print.`,
      ].join("\n"),
    );
    return null;
  }
  const mode = modeOf(flags);
  const config = readConfig(flags.config);
  assertStaging(config, { env: flags.env, confirm: flags.confirm, writes: mode === "live" });
  const resources = platformResources(config);
  if (!resources.database || !resources.exportsBucket) throw new DrillError("the config needs PLATFORM_DB and the EXPORTS bucket");

  const stateDir = resolve(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  let stateFile = flags.continue ? resolve(root, flags.continue) : null;
  let state;
  if (stateFile) {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (flags.tenant && flags.tenant !== state.tenant.slug) throw new DrillError(`${flags.continue} is the drill of ${state.tenant.slug}, not ${flags.tenant}`);
  } else {
    if (!flags.tenant || !/^[a-z0-9-]{3,30}$/.test(flags.tenant)) throw new DrillError("--tenant <slug> is required");
    const unfinished = latestState(stateDir, flags.tenant);
    if (unfinished && mode === "live") {
      const previous = JSON.parse(readFileSync(unfinished, "utf8"));
      if (!previous.result) throw new DrillError(`an earlier drill of ${flags.tenant} didn't finish: npm run hosted-restore-drill -- --continue ${relative(root, unfinished)} ...`);
    }
    state = { slug: flags.tenant, startedAt: now(), completed: [] };
    stateFile = join(stateDir, `restore-${flags.tenant}-${stamp(now())}.json`);
  }
  const exec = makeExecutor({ mode, run, fetch, log });
  const ctx = {
    exec,
    log,
    env,
    now,
    wait,
    root,
    stateDir,
    state,
    slug: state.slug,
    configPath: flags.config,
    platformDb: resources.database,
    exportsBucket: resources.exportsBucket,
    masterKey: null,
  };
  const save = () => {
    if (mode === "live") writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  };

  log(`Restore drill of ${state.slug} on ${resources.database} (${mode}${mode === "live" ? "" : ": nothing is changed"}).`);
  // A dry run reads what it can for real up to the export; every step after
  // depends on changes it doesn't make, so from there it only prints.
  const printer = makeExecutor({ mode: "print", log, commands: exec.commands });
  try {
    for (const name of STEPS) {
      if (state.completed.includes(name)) continue;
      if (mode === "dry-run" && STEPS.indexOf(name) >= STEPS.indexOf("export")) ctx.exec = printer;
      // A continued drill opens the key again before its next step.
      if (!ctx.loaded && name !== "preflight") await loadTenant(ctx, { requireReady: false });
      log(`\n== ${name}`);
      await steps[name](ctx);
      if (mode === "live") {
        state.completed.push(name);
        save();
      }
    }
  } catch (error) {
    if (mode === "live" && state.quiescedAt && !state.deletedAt) {
      log("\nThe drill stopped before deleting anything; putting the tenant back.");
      await unquiesce(ctx);
      state.result = "stopped, tenant put back";
      save();
    } else if (mode === "live" && state.deletedAt) {
      save();
      log(
        [
          "",
          "The drill stopped after the tenant's database was deleted. It stays off the air (paused in provisioning) until the drill finishes.",
          `The export is ${state.dumpFile ?? "in R2"} (${state.export?.prefix ?? ""}openping.sql in ${ctx.exportsBucket}).`,
          `Fix the cause, then: npm run hosted-restore-drill -- --env staging --config ${flags.config} --confirm ${config.name} --continue ${relative(root, stateFile)}`,
        ].join("\n"),
      );
    }
    throw error;
  }
  if (mode !== "live") {
    log(`\n${mode === "print" ? "Printed only; nothing ran." : "Dry run: the read-only steps ran, nothing was changed."} ${exec.commands.length} commands.`);
    return { state, commands: exec.commands };
  }
  state.result = "passed";
  state.finishedAt = now();
  if (state.dumpFile && !flags["keep-dump"]) {
    rmSync(resolve(root, state.dumpFile), { force: true });
    state.dumpFile = null;
  }
  save();
  log(`\n${summary(state)}\nState: ${relative(root, stateFile)}`);
  return { state, commands: exec.commands };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof DrillError ? `hosted-restore-drill: ${error.message}` : error);
    process.exit(1);
  });
}
