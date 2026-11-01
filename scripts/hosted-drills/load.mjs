#!/usr/bin/env node
// `npm run hosted-load -- <plan|seed|run|report|cleanup> --env staging --config <staging platform config> [options]`
//
// The load test of the Hosted build plan (docs/HOSTED_BUILD_PLAN.md, section
// 9): 200 tenants with 20 monitors each against staging for an hour, with no
// missed scheduler runs, queue lag under a minute, and the cost per tenant
// measured against the cost model. The runbook is docs/hosted/LAUNCH_DRILLS.md.
//
//   plan     what the run will create, cost and take, and every command, without running any
//   seed     deploys the echo Worker, adds the tenants as rows the platform's
//            own provisioning then sets up, waits for all of them to be ready,
//            and adds each one's monitors
//   run      samples the scheduler's numbers and /__health every minute for
//            the warm-up and the duration, then reads the platform's minutes
//            and Cloudflare's analytics, and writes the report
//   report   writes the report again from what `run` saved (and fetches the
//            analytics if they were missing)
//   cleanup  removes the run's tenants through the platform's teardown, then
//            the rows it keeps and the echo Worker
//
// Every command is printed before it runs; --print runs none, --dry-run only
// the read-only ones. A run that changes anything needs --confirm with the
// staging platform Worker's name. The state of a run is in
// .hosted-drills/load-<run>.json; later commands find the newest one, or take
// --run <id>.
//
// It works the same with or without Workers for Platforms: tenants are set up
// and torn down by the platform's provisioning, whatever it uploads to.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DrillError,
  ROOT,
  STATE_DIR,
  assertStaging,
  d1File,
  d1Info,
  d1InfoId,
  d1Query,
  d1Results,
  d1Rows,
  httpRequest,
  makeExecutor,
  modeOf,
  parseArgs,
  parseDuration,
  parsePositiveInt,
  platformResources,
  randomId,
  readConfig,
  sleep,
  sqlValue,
  waitFor,
} from "./lib.mjs";
import { isValidKey, openEscrowedKey, sealConfig } from "./keys.mjs";
import {
  LOAD_INTERVAL_SECONDS,
  leftoversSql,
  loadTenantFilter,
  loadTenants,
  markForRemovalSql,
  monitorSeedSql,
  monitorTargets,
  platformSeedSql,
  provisionStatusSql,
  remainingTenantsSql,
  seedKeysSql,
} from "./seed.mjs";
import { buildReport, renderReport, TARGETS } from "./report.mjs";
import { GRAPHQL_URL, analyticsRequest, isUnknownFieldError, parseAnalytics } from "./analytics.mjs";
import { PLATFORM_KEY_ENV } from "./restore.mjs";

export const ECHO_CONFIG = "scripts/hosted-drills/echo-worker/wrangler.jsonc";
export const ANALYTICS_TOKEN_ENV = "CLOUDFLARE_ANALYTICS_TOKEN";
export const ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";

export const DEFAULTS = {
  tenants: 200,
  monitors: 20,
  duration: "60m",
  warmup: "13m",
  every: "60s",
  seedTimeout: "150m",
  cleanupTimeout: "150m",
};

/** The platform's provisioning sweep takes this many tenants a minute (provisionDue's limit, platform/src/provisioning.ts). */
const SWEEP_PER_MINUTE = 10;

export const SNAPSHOT_COLUMNS = "tenant_id, last_run_id, last_at, last_outcome, last_lag_ms, last_duration_ms, last_tenant_ms, last_checked, last_failures, last_d1_queries, day, day_runs, day_errors";

// --- State -------------------------------------------------------------------------

function stateFileOf(stateDir, runId) {
  return join(stateDir, `load-${runId}.json`);
}

function newestRun(stateDir) {
  if (!existsSync(stateDir)) return null;
  const runs = readdirSync(stateDir)
    .filter((f) => /^load-[a-z0-9]{4}\.json$/.test(f))
    .map((f) => ({ f, at: JSON.parse(readFileSync(join(stateDir, f), "utf8")).createdAt ?? 0 }))
    .sort((a, b) => a.at - b.at);
  return runs.length ? runs.at(-1).f.slice(5, 9) : null;
}

function loadState(ctx, flags) {
  const runId = flags.run ?? newestRun(ctx.stateDir);
  if (!runId) throw new DrillError("no load test run found in .hosted-drills/; seed one first, or name it with --run");
  const file = stateFileOf(ctx.stateDir, runId);
  if (!existsSync(file)) throw new DrillError(`no state for run ${runId} (${relative(ctx.root, file)})`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function saveState(ctx, state) {
  if (ctx.exec.mode === "live") writeFileSync(stateFileOf(ctx.stateDir, state.runId), JSON.stringify(state) + "\n");
}

// --- Plan ---------------------------------------------------------------------------

export function planText({ tenants, monitors, durationMs, warmupMs, everyMs, config }) {
  const runsPerTenant = Math.floor(durationMs / (LOAD_INTERVAL_SECONDS * 1000));
  const checksPerMinute = (tenants * monitors) / (LOAD_INTERVAL_SECONDS / 60);
  const samples = Math.ceil((durationMs + warmupMs) / everyMs);
  return [
    `Load test plan for ${config.name}:`,
    `- ${tenants} tenants (lt-<run>-001 to lt-<run>-${String(tenants).padStart(3, "0")}), each on the paid plan with ${monitors} HTTP monitors at 12-minute checks, all pointing at the echo Worker.`,
    `- Setting them up goes through the platform's own provisioning, about ${SWEEP_PER_MINUTE} a minute: about ${Math.ceil(tenants / SWEEP_PER_MINUTE)} minutes, creating ${tenants} D1 databases and ${tenants} tenant Workers.`,
    `- Then ${Math.round(warmupMs / 60_000)} minutes of warm-up and ${Math.round(durationMs / 60_000)} minutes measured: about ${runsPerTenant * tenants} scheduler runs and ${Math.round(checksPerMinute)} checks a minute.`,
    `- ${samples} samples of /__health and of the scheduler's numbers (one D1 query of ${tenants} rows each).`,
    `- Passes when: ${TARGETS.missedRuns} missed runs, queue lag under ${TARGETS.queueLagMaxMs / 1000} s, no run without a clean answer, /__health ok throughout, and at most $${TARGETS.costPerTenantMonth.toFixed(2)} a month per tenant.`,
    `- Cleanup removes every tenant, database, Worker and row it made, and the echo Worker; about ${Math.ceil(tenants / SWEEP_PER_MINUTE)} minutes.`,
    "- What it costs: well inside Workers Paid's allowances (about 0.2 million D1 rows written and a few thousand requests for the hour).",
  ].join("\n");
}

// --- Seed ---------------------------------------------------------------------------

async function deployEcho(ctx, flags) {
  if (flags["echo-url"]) return flags["echo-url"].replace(/\/+$/, "");
  const out = await ctx.exec({ kind: "run", argv: ["npx", "wrangler", "deploy", "--config", ECHO_CONFIG], write: true, what: "deploy the echo Worker the monitors check" });
  if (out === null) return "https://openping-loadtest-echo-staging.<your workers.dev subdomain>.workers.dev";
  const url = /https:\/\/[^\s]+\.workers\.dev/.exec(out)?.[0];
  if (!url) throw new DrillError("couldn't read the echo Worker's address from wrangler's output; pass --echo-url");
  return url;
}

async function seed(ctx, flags) {
  const tenantsCount = parsePositiveInt(flags.tenants ?? DEFAULTS.tenants, "--tenants", { max: 500 });
  const monitors = parsePositiveInt(flags.monitors ?? DEFAULTS.monitors, "--monitors", { max: 20 });
  const platformKey = ctx.env[PLATFORM_KEY_ENV];
  if (ctx.exec.reads && !isValidKey(platformKey)) throw new DrillError(`${PLATFORM_KEY_ENV} must hold the staging platform's PLATFORM_KEY (32 bytes, base64): seeding seals each tenant's monitors with its escrowed key`);

  // seed --run <id> picks up a seed that stopped (a paused tenant resumed in the console, a lost connection).
  if (flags.run) {
    const state = loadState(ctx, flags);
    ctx.log(`Run ${state.runId}: continuing its seed.`);
    await waitReady(ctx, state, flags, ctx.exec.writes);
    await seedMonitors(ctx, state, platformKey);
    return state;
  }
  const runId = randomId(4);
  const now = ctx.now();
  const tenants = loadTenants({ runId, count: tenantsCount, newTenantId: () => randomId(16) });
  const state = { runId, createdAt: now, configName: ctx.config.name, platformDb: ctx.platformDb, appOrigin: ctx.appOrigin, monitorsPerTenant: monitors, intervalMinutes: LOAD_INTERVAL_SECONDS / 60, tenants, snapshots: [], health: [] };
  ctx.log(`Run ${runId}: ${tenantsCount} tenants, ${monitors} monitors each.`);

  state.echoDeployed = !flags["echo-url"];
  state.echoUrl = await deployEcho(ctx, flags);
  const echo = await ctx.exec(httpRequest(`${state.echoUrl}/ok`, { what: "check the echo Worker answers" }));
  if (echo && echo.status !== 200) throw new DrillError(`the echo Worker answered ${echo.status} at ${state.echoUrl}/ok`);
  saveState(ctx, state);

  const platformSql = join(ctx.stateDir, `load-${runId}-platform.sql`);
  if (ctx.exec.writes) writeFileSync(platformSql, platformSeedSql(tenants, { now }));
  const added = await ctx.exec(d1File(ctx, ctx.platformDb, relative(ctx.root, platformSql), { what: `add ${tenantsCount} accounts and tenants for the platform to provision` }));
  state.seededAt = now;
  saveState(ctx, state);
  await waitReady(ctx, state, flags, added !== null);
  await seedMonitors(ctx, state, platformKey);
  return state;
}

async function waitReady(ctx, state, flags, live) {
  const runId = state.runId;
  const tenantsCount = state.tenants.length;
  const status = d1Query(ctx, ctx.platformDb, provisionStatusSql(runId), { what: "check how far provisioning got" });
  if (!live) {
    await ctx.exec(status);
    return;
  }
  await waitFor(
    async () => {
      const [counts, paused] = d1Results(await ctx.exec(status));
      const ready = counts.filter((c) => c.state === "ready").reduce((n, c) => n + c.n, 0);
      if (paused.length) throw new DrillError(`provisioning paused ${paused.length} tenants (first: ${paused[0].slug}, ${paused[0].error}); resume them in the admin console, then: npm run hosted-load -- seed --run ${runId} ...`);
      ctx.log(`  ${ready} of ${tenantsCount} ready`);
      return ready === tenantsCount ? true : undefined;
    },
    { everyMs: 60_000, timeoutMs: parseDuration(flags["seed-timeout"] ?? DEFAULTS.seedTimeout, "--seed-timeout"), what: "every tenant to be ready", now: ctx.now, wait: ctx.wait, log: ctx.log },
  );
}

/** Adds each ready tenant's monitors; a tenant that has them already is skipped (so it can be repeated). */
async function seedMonitors(ctx, state, platformKey) {
  const keysAnswer = await ctx.exec(d1Query(ctx, ctx.platformDb, seedKeysSql(state.runId), { what: "read each tenant's database and escrowed key (sealed; opened here with PLATFORM_KEY)" }));
  const rows = keysAnswer ? d1Rows(keysAnswer) : [{ tenant_id: "<tenant id>", d1_id: null, kid: null, ciphertext: null }];
  const targets = monitorTargets(state.echoUrl, state.monitorsPerTenant);
  state.seeded ??= [];
  for (const row of rows) {
    const t = state.tenants.find((x) => x.tenantId === row.tenant_id);
    if (t) t.d1Id = row.d1_id;
    if (state.seeded.includes(row.tenant_id)) continue;
    const database = `openping-t-${row.tenant_id}`;
    const file = join(ctx.stateDir, `load-${state.runId}-monitors-${row.tenant_id}.sql`);
    if (keysAnswer) {
      const masterKey = await openEscrowedKey({ kid: row.kid, ciphertext: row.ciphertext }, row.tenant_id, platformKey);
      const sql = await monitorSeedSql({ targets, seal: (config) => sealConfig(masterKey, config), now: ctx.now(), newMonitorId: () => `mon_${crypto.randomUUID()}` });
      if (ctx.exec.writes) writeFileSync(file, sql, { mode: 0o600 });
    }
    const done = await ctx.exec(d1File(ctx, database, relative(ctx.root, file), { what: `add ${targets.length} monitors to ${row.slug ?? "each tenant"} (one command per tenant)` }));
    if (done !== null) {
      state.seeded.push(row.tenant_id);
      saveState(ctx, state);
    }
    if (!keysAnswer) break;
  }
  if (keysAnswer) ctx.log(`Seeded ${state.seeded.length} tenants. Next: npm run hosted-load -- run --run ${state.runId} ...`);
}

// --- Run ------------------------------------------------------------------------------

function snapshotSql(runId) {
  return `SELECT ${SNAPSHOT_COLUMNS} FROM scheduler_stats WHERE tenant_id IN (SELECT id FROM tenants WHERE ${loadTenantFilter(runId)})`;
}

async function sampleOnce(ctx, state) {
  const at = ctx.now();
  const health = await ctx.exec(httpRequest(`${state.appOrigin}/__health`, { what: "the platform's health" }));
  if (health) state.health.push({ at, status: health.status, ok: health.json?.ok ?? false, checks: health.json?.checks ?? null });
  const snap = await ctx.exec(d1Query(ctx, ctx.platformDb, snapshotSql(state.runId), { what: "the run's tenants' scheduler numbers" }));
  if (snap) state.snapshots.push({ at, rows: d1Rows(snap) });
}

async function collectAfter(ctx, state) {
  const { windowStart, windowEnd } = state.window;
  const minutes = await ctx.exec(
    d1Query(ctx, ctx.platformDb, `SELECT * FROM scheduler_minutes WHERE minute >= ${sqlValue(Math.floor(windowStart / 60_000))} AND minute <= ${sqlValue(Math.floor(windowEnd / 60_000))} ORDER BY minute`, { what: "the platform's per-minute scheduler numbers (the Operations tab's)" }),
  );
  if (minutes) state.minutes = d1Rows(minutes);
  const ids = await ctx.exec(d1Query(ctx, ctx.platformDb, `SELECT id, d1_id FROM tenants WHERE ${loadTenantFilter(state.runId)}`, { what: "the run's tenants' database ids" }));
  if (ids) for (const r of d1Rows(ids)) {
    const t = state.tenants.find((x) => x.tenantId === r.id);
    if (t) t.d1Id = r.d1_id;
  }
  const info = await ctx.exec(d1Info(ctx, ctx.platformDb, { what: "the platform database's id" }));
  if (info && !info.failed) state.platformDatabaseId = d1InfoId(info);
  await fetchAnalytics(ctx, state);
}

async function fetchAnalytics(ctx, state) {
  const token = ctx.env[ANALYTICS_TOKEN_ENV];
  const accountId = ctx.env[ACCOUNT_ID_ENV];
  if (ctx.exec.reads && (!token || !accountId)) {
    ctx.log(`  ${ANALYTICS_TOKEN_ENV} and ${ACCOUNT_ID_ENV} aren't both set: D1 rows, CPU and the cost won't be measured (the report says so).`);
    return;
  }
  const query = (granularity) =>
    analyticsRequest({
      accountId: accountId ?? "<account id>",
      start: state.window.windowStart,
      end: state.window.windowEnd,
      databaseIds: [...state.tenants.map((t) => t.d1Id).filter(Boolean), ...(state.platformDatabaseId ? [state.platformDatabaseId] : [])],
      scriptNames: state.tenants.map((t) => `t-${t.tenantId}`),
      granularity,
    });
  const ask = (request) =>
    ctx.exec(
      httpRequest(GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token ?? "<token>"}`, "content-type": "application/json" },
        secretHeaders: ["authorization"],
        body: JSON.stringify(request.body),
        what: "D1 rows and Worker CPU for the window (GraphQL Analytics)",
      }),
    );
  let request = query("minute");
  let answer = await ask(request);
  if (!answer) return;
  let parsed = parseAnalytics(answer.json, { d1Scale: request.d1Scale });
  if (parsed.error && isUnknownFieldError(parsed.error)) {
    ctx.log("  D1's analytics don't filter by minute here; asking by the hour and scaling to the window.");
    request = query("hour");
    answer = await ask(request);
    parsed = parseAnalytics(answer.json, { d1Scale: request.d1Scale });
  }
  if (parsed.error) {
    ctx.log(`  GraphQL Analytics answered ${answer.status}: ${parsed.error}. The report leaves the cost unmeasured; report --run ${state.runId} tries again.`);
    return;
  }
  state.analytics = parsed;
}

async function runLoad(ctx, flags) {
  const state = loadState(ctx, flags);
  if (!state.seeded?.length && ctx.exec.reads) throw new DrillError(`run ${state.runId} has no seeded tenants; finish seed first`);
  const durationMs = parseDuration(flags.duration ?? DEFAULTS.duration, "--duration");
  const warmupMs = parseDuration(flags.warmup ?? DEFAULTS.warmup, "--warmup");
  const everyMs = parseDuration(flags.every ?? DEFAULTS.every, "--every");
  if (everyMs > LOAD_INTERVAL_SECONDS * 1000 / 2) throw new DrillError("--every must be at most 6 minutes, so every 12-minute run is seen");
  const start = ctx.now();
  state.window = { windowStart: start + warmupMs, windowEnd: start + warmupMs + durationMs };
  state.snapshots = [];
  state.health = [];
  ctx.log(`Run ${state.runId}: ${Math.round(warmupMs / 60_000)} minutes of warm-up, then ${Math.round(durationMs / 60_000)} measured, sampling every ${Math.round(everyMs / 1000)} s.`);
  if (!ctx.exec.reads) {
    await sampleOnce(ctx, state);
    ctx.log(`  (repeated every ${Math.round(everyMs / 1000)} s until ${new Date(state.window.windowEnd).toISOString()})`);
  } else {
    for (;;) {
      await sampleOnce(ctx, state);
      saveState(ctx, state);
      if (ctx.now() >= state.window.windowEnd) break;
      const last = state.health.at(-1);
      ctx.log(`  ${new Date(ctx.now()).toISOString()}: health ${last ? (last.ok ? "ok" : `NOT ok (${last.status})`) : "?"}, ${state.snapshots.at(-1)?.rows.length ?? 0} tenants reporting`);
      await ctx.wait(Math.min(everyMs, Math.max(0, state.window.windowEnd - ctx.now())));
    }
  }
  await collectAfter(ctx, state);
  saveState(ctx, state);
  return writeReport(ctx, state);
}

function writeReport(ctx, state) {
  if (!ctx.exec.reads) return null;
  const report = buildReport(state);
  const text = renderReport(report);
  if (ctx.exec.mode === "live") {
    writeFileSync(join(ctx.stateDir, `load-${state.runId}-report.md`), text);
    writeFileSync(join(ctx.stateDir, `load-${state.runId}-report.json`), JSON.stringify(report, null, 2) + "\n");
  }
  ctx.log(`\n${text}`);
  return report;
}

async function report(ctx, flags) {
  const state = loadState(ctx, flags);
  if (!state.window) throw new DrillError(`run ${state.runId} hasn't been run yet`);
  if (!state.analytics) {
    await fetchAnalytics(ctx, state);
    saveState(ctx, state);
  }
  return writeReport(ctx, state);
}

// --- Cleanup ----------------------------------------------------------------------------

async function cleanup(ctx, flags) {
  const state = loadState(ctx, flags);
  const runId = state.runId;
  const marked = await ctx.exec(d1Query(ctx, ctx.platformDb, markForRemovalSql(runId, { now: ctx.now() }), { write: true, what: `mark run ${runId}'s tenants for removal (the platform tears each down: Worker, database, key, row)` }));
  const remaining = d1Query(ctx, ctx.platformDb, remainingTenantsSql(runId), { what: "count the run's tenants left" });
  if (marked === null) await ctx.exec(remaining);
  else {
    await waitFor(
      async () => {
        const [{ n }] = d1Rows(await ctx.exec(remaining));
        ctx.log(`  ${n} tenants left`);
        return n === 0 ? true : undefined;
      },
      { everyMs: 60_000, timeoutMs: parseDuration(flags["cleanup-timeout"] ?? DEFAULTS.cleanupTimeout, "--cleanup-timeout"), what: "every tenant to be torn down", now: ctx.now, wait: ctx.wait, log: ctx.log },
    );
  }
  const leftovers = join(ctx.stateDir, `load-${runId}-leftovers.sql`);
  if (ctx.exec.writes) writeFileSync(leftovers, leftoversSql(runId, state.tenants.map((t) => t.tenantId)));
  await ctx.exec(d1File(ctx, ctx.platformDb, relative(ctx.root, leftovers), { what: "delete the rows the teardown keeps on purpose (held slugs, history) and the accounts" }));
  if (state.echoDeployed !== false && !flags["keep-echo"]) {
    await ctx.exec({ kind: "run", argv: ["npx", "wrangler", "delete", "--config", ECHO_CONFIG], write: true, what: "delete the echo Worker" });
  }
  if (ctx.exec.writes) {
    for (const f of readdirSync(ctx.stateDir)) if (f.startsWith(`load-${runId}-`) && f.endsWith(".sql")) rmSync(join(ctx.stateDir, f), { force: true });
    state.cleanedAt = ctx.now();
    saveState(ctx, state);
    ctx.log(`Run ${runId} cleaned up. Its report stays in ${STATE_DIR}/load-${runId}-report.md.`);
  }
  return state;
}

// --- The command --------------------------------------------------------------------------

const USAGE = [
  "npm run hosted-load -- <plan|seed|run|report|cleanup> --env staging --config <staging platform config> [options]",
  "  --confirm <name>         the staging platform Worker's name, for seed, run and cleanup",
  "  --tenants 200 --monitors 20    (seed, plan)",
  "  --duration 60m --warmup 13m --every 60s    (run, plan)",
  "  --echo-url <url>         use an echo Worker already deployed instead of deploying one",
  "  --run <id>               the run (default: the newest in .hosted-drills/)",
  "  --dry-run                run only the read-only commands",
  "  --print                  print every command, run none",
  `seed needs ${PLATFORM_KEY_ENV}; run and report measure D1 and CPU with ${ANALYTICS_TOKEN_ENV} (Account Analytics Read) and ${ACCOUNT_ID_ENV}.`,
].join("\n");

export async function main(argv, { run, fetch, log = console.log, env = process.env, now = Date.now, wait = sleep, root = ROOT } = {}) {
  const { positional, flags } = parseArgs(argv, ["dry-run", "print", "help", "keep-echo"]);
  const [command] = positional;
  if (!command || flags.help || command === "help") {
    log(USAGE);
    return null;
  }
  if (!["plan", "seed", "run", "report", "cleanup"].includes(command)) throw new DrillError(`unknown command ${command}\n${USAGE}`);
  const mode = command === "plan" ? "print" : modeOf(flags);
  const config = readConfig(flags.config);
  // run only reads, but it needs the same confirmation: it is an hour against staging.
  assertStaging(config, { env: flags.env, confirm: flags.confirm, writes: mode === "live" && command !== "report" });
  const resources = platformResources(config);
  if (!resources.database) throw new DrillError("the config binds no PLATFORM_DB");
  const stateDir = resolve(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const exec = makeExecutor({ mode, run, fetch, log });
  const ctx = { exec, log, env, now, wait, root, stateDir, config, configPath: flags.config, platformDb: resources.database, appOrigin: resources.appOrigin };

  switch (command) {
    case "plan": {
      const durationMs = parseDuration(flags.duration ?? DEFAULTS.duration, "--duration");
      const warmupMs = parseDuration(flags.warmup ?? DEFAULTS.warmup, "--warmup");
      const everyMs = parseDuration(flags.every ?? DEFAULTS.every, "--every");
      const tenants = parsePositiveInt(flags.tenants ?? DEFAULTS.tenants, "--tenants", { max: 500 });
      const monitors = parsePositiveInt(flags.monitors ?? DEFAULTS.monitors, "--monitors", { max: 20 });
      log(planText({ tenants, monitors, durationMs, warmupMs, everyMs, config }));
      log("\nThe commands, in order (shown for one tenant where they repeat per tenant):\n\n# seed");
      const state = await seed(ctx, { ...flags, tenants: String(Math.min(tenants, 1)) });
      log("\n# run");
      state.seeded = [];
      Object.assign(state, { window: { windowStart: now(), windowEnd: now() + durationMs } });
      await sampleOnce(ctx, state);
      await collectAfter(ctx, state);
      log("\n# cleanup");
      await cleanupPrinted(ctx, state);
      return { commands: exec.commands };
    }
    case "seed":
      return seed(ctx, flags);
    case "run":
      return runLoad(ctx, flags);
    case "report":
      return report(ctx, flags);
    case "cleanup":
      return cleanup(ctx, flags);
  }
  return null;
}

async function cleanupPrinted(ctx, state) {
  await ctx.exec(d1Query(ctx, ctx.platformDb, markForRemovalSql(state.runId, { now: ctx.now() }), { write: true, what: "mark the run's tenants for removal" }));
  await ctx.exec(d1Query(ctx, ctx.platformDb, remainingTenantsSql(state.runId), { what: "count the run's tenants left (every minute until none)" }));
  await ctx.exec(d1File(ctx, ctx.platformDb, `${STATE_DIR}/load-${state.runId}-leftovers.sql`, { what: "delete the held slugs, history rows and accounts" }));
  if (state.echoDeployed !== false) await ctx.exec({ kind: "run", argv: ["npx", "wrangler", "delete", "--config", ECHO_CONFIG], write: true, what: "delete the echo Worker" });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((result) => {
      if (result && typeof result === "object" && "verdict" in result) process.exit(result.verdict === "pass" ? 0 : result.verdict === "fail" ? 1 : 3);
    })
    .catch((error) => {
      console.error(error instanceof DrillError ? `hosted-load: ${error.message}` : error);
      process.exit(1);
    });
}
