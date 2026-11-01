// The load test's report: what the samples taken during the run say, against
// the targets of the build plan (docs/HOSTED_BUILD_PLAN.md, section 9) and the
// cost model (docs/HOSTED_PLAN.md, "Cost per customer, measured").
//
// Pure: everything here is arithmetic on what `hosted-load run` collected, so
// report.test.mjs pins every number.

export const MINUTE_MS = 60_000;
export const HOURS_A_MONTH = 720;

/**
 * The targets. Queue lag is the platform's own measure (from the minute a
 * tenant was due to the moment the consumer called it, scheduler_stats
 * .last_lag_ms); a run is missed when a tenant goes a whole interval past its
 * due time without one.
 */
export const TARGETS = {
  missedRuns: 0,
  queueLagMaxMs: 60_000,
  runErrors: 0,
  healthFailures: 0,
  /** Dollars a month per tenant: the cost model's worst case for the base plan (HOSTED_PLAN.md, launch pricing). */
  costPerTenantMonth: 0.83,
};

/** Workers Paid and Workers for Platforms prices past their allowances (checked 2026-10-28; platform/README.md). */
export const PRICES = {
  d1RowsWrittenPerMillion: 1.0,
  d1RowsReadPerMillion: 0.001,
  requestsPerMillion: 0.3,
  cpuMsPerMillion: 0.02,
  queueOpsPerMillion: 0.4,
  /** Queue operations per scheduler run: one message, written, read and deleted. */
  queueOpsPerRun: 3,
  /** Worker requests per run: the consumer's share is tiny; the call into the tenant is one. */
  requestsPerRun: 1,
};

/** Nearest-rank percentile of numbers (unsorted is fine); null for none. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Every distinct run the snapshots saw, per tenant, inside the window. A
 * snapshot is the run's tenants' scheduler_stats rows at one moment; a run
 * shows in it until the tenant's next run replaces it, so sampling more often
 * than a tenant runs sees each run at least once.
 */
export function collectRuns(snapshots, { windowStart, windowEnd }) {
  const byTenant = new Map();
  for (const snap of snapshots) {
    for (const row of snap.rows) {
      if (!row.last_run_id || row.last_at < windowStart || row.last_at > windowEnd) continue;
      let runs = byTenant.get(row.tenant_id);
      if (!runs) byTenant.set(row.tenant_id, (runs = new Map()));
      if (!runs.has(row.last_run_id)) {
        runs.set(row.last_run_id, {
          runId: row.last_run_id,
          at: row.last_at,
          outcome: row.last_outcome,
          lagMs: row.last_lag_ms,
          durationMs: row.last_duration_ms,
          tenantMs: row.last_tenant_ms ?? null,
          checked: row.last_checked ?? 0,
          failures: row.last_failures ?? 0,
          d1Queries: row.last_d1_queries ?? 0,
        });
      }
    }
  }
  const out = new Map();
  for (const [tenant, runs] of byTenant) out.set(tenant, [...runs.values()].sort((a, b) => a.at - b.at));
  return out;
}

/**
 * Runs a tenant missed in the window: for each gap between its run starts
 * (and between the window's edges and its first and last run), every whole
 * interval-plus-tolerance the gap holds past the first is a run that should
 * have happened and didn't. A late run (inside the tolerance) is not missed;
 * it shows as queue lag instead. At the window's edges the tenant's phase
 * isn't known, so a gap there counts the runs it must at least have missed.
 * A tenant with no run at all missed every interval of the window.
 */
export function missedRuns(runStarts, { windowStart, windowEnd, intervalMs, toleranceMs = 2 * MINUTE_MS }) {
  const span = windowEnd - windowStart;
  if (!runStarts.length) return Math.max(1, Math.floor(span / intervalMs));
  const edges = [windowStart, ...[...runStarts].sort((a, b) => a - b), windowEnd];
  let missed = 0;
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i] - edges[i - 1];
    missed += Math.max(0, Math.ceil(gap / (intervalMs + toleranceMs)) - 1);
  }
  return missed;
}

/**
 * The estimated cost of one tenant for a month, from what one tenant used in
 * the window on average, at the prices past the included allowances (the
 * cost model's convention: what a customer adds at the margin).
 */
export function costPerTenantMonth({ windowMs, tenants, runs, d1 = null, platformD1 = null, workers = null, prices = PRICES }) {
  if (!tenants || windowMs <= 0) return null;
  const perMonth = (HOURS_A_MONTH * 3_600_000) / windowMs / tenants;
  const lines = {};
  if (d1) {
    lines.tenantRowsWritten = ((d1.rowsWritten * perMonth) / 1e6) * prices.d1RowsWrittenPerMillion;
    lines.tenantRowsRead = ((d1.rowsRead * perMonth) / 1e6) * prices.d1RowsReadPerMillion;
  }
  if (platformD1) {
    lines.platformRowsWritten = ((platformD1.rowsWritten * perMonth) / 1e6) * prices.d1RowsWrittenPerMillion;
    lines.platformRowsRead = ((platformD1.rowsRead * perMonth) / 1e6) * prices.d1RowsReadPerMillion;
  }
  const requests = workers?.requests ?? runs * prices.requestsPerRun;
  lines.requests = ((requests * perMonth) / 1e6) * prices.requestsPerMillion;
  lines.queue = ((runs * prices.queueOpsPerRun * perMonth) / 1e6) * prices.queueOpsPerMillion;
  if (workers?.cpuMs !== undefined && workers?.cpuMs !== null) lines.cpu = ((workers.cpuMs * perMonth) / 1e6) * prices.cpuMsPerMillion;
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  // Without the tenants' own D1 rows (most of the cost) the number means nothing.
  return { total: d1 ? total : null, lines, measured: { d1: !!d1, platformD1: !!platformD1, workers: !!workers } };
}

/** Adds up the GraphQL answers for the run's databases and scripts. */
export function sumAnalytics(analytics, { tenantDatabaseIds, platformDatabaseId, scriptNames }) {
  if (!analytics) return { d1: null, platformD1: null, workers: null };
  const dbIds = new Set(tenantDatabaseIds);
  const scripts = new Set(scriptNames);
  let d1 = null;
  let platformD1 = null;
  for (const row of analytics.d1 ?? []) {
    const target = dbIds.has(row.databaseId) ? "tenant" : row.databaseId === platformDatabaseId ? "platform" : null;
    if (!target) continue;
    const add = { rowsRead: row.rowsRead ?? 0, rowsWritten: row.rowsWritten ?? 0, readQueries: row.readQueries ?? 0, writeQueries: row.writeQueries ?? 0 };
    if (target === "tenant") d1 = merge(d1, add);
    else platformD1 = merge(platformD1, add);
  }
  let workers = null;
  for (const row of analytics.workers ?? []) {
    if (!scripts.has(row.scriptName)) continue;
    // CPU per request is only known as quantiles: P99 times the requests is a ceiling, never an under-estimate.
    const add = { requests: row.requests ?? 0, errors: row.errors ?? 0, cpuMs: ((row.cpuTimeP99 ?? 0) / 1000) * (row.requests ?? 0), cpuP50Us: [row.cpuTimeP50 ?? 0], cpuP99Us: [row.cpuTimeP99 ?? 0] };
    workers = workers
      ? { requests: workers.requests + add.requests, errors: workers.errors + add.errors, cpuMs: workers.cpuMs + add.cpuMs, cpuP50Us: [...workers.cpuP50Us, ...add.cpuP50Us], cpuP99Us: [...workers.cpuP99Us, ...add.cpuP99Us] }
      : add;
  }
  return { d1, platformD1, workers };
}

function merge(a, b) {
  if (!a) return { ...b };
  return { rowsRead: a.rowsRead + b.rowsRead, rowsWritten: a.rowsWritten + b.rowsWritten, readQueries: a.readQueries + b.readQueries, writeQueries: a.writeQueries + b.writeQueries };
}

/**
 * The whole report. `state` is what `hosted-load run` saved: the run's
 * settings, its tenants, the snapshots, the health checks, the platform's
 * scheduler_minutes rows and the analytics.
 */
export function buildReport(state, { targets = TARGETS, prices = PRICES } = {}) {
  const { windowStart, windowEnd } = state.window;
  const windowMs = windowEnd - windowStart;
  const intervalMs = state.intervalMinutes * MINUTE_MS;
  const tenantIds = state.tenants.map((t) => t.tenantId);
  const runsByTenant = collectRuns(state.snapshots ?? [], { windowStart, windowEnd });

  const all = [];
  let missed = 0;
  const worst = [];
  for (const id of tenantIds) {
    const runs = runsByTenant.get(id) ?? [];
    all.push(...runs);
    const ok = runs.filter((r) => r.outcome === "ran" || r.outcome === "lease_busy");
    const m = missedRuns(ok.map((r) => r.at), { windowStart, windowEnd, intervalMs });
    missed += m;
    if (m) worst.push({ tenantId: id, slug: state.tenants.find((t) => t.tenantId === id)?.slug ?? id, missed: m, runs: runs.length });
  }
  worst.sort((a, b) => b.missed - a.missed);

  const lags = all.map((r) => r.lagMs);
  const durations = all.map((r) => r.durationMs);
  const minutes = state.minutes ?? [];
  const platformLagMax = minutes.reduce((n, m) => Math.max(n, m.lag_max_ms ?? 0), 0);
  const lagMax = Math.max(lags.length ? Math.max(...lags) : 0, platformLagMax);
  const errors = all.filter((r) => r.outcome !== "ran" && r.outcome !== "lease_busy");
  const health = state.health ?? [];
  const healthFailures = health.filter((h) => h.status !== 200 || h.ok !== true);
  const failingChecks = {};
  for (const h of healthFailures) for (const [name, ok] of Object.entries(h.checks ?? {})) if (ok === false) failingChecks[name] = (failingChecks[name] ?? 0) + 1;

  const sums = sumAnalytics(state.analytics ?? null, {
    tenantDatabaseIds: state.tenants.map((t) => t.d1Id).filter(Boolean),
    platformDatabaseId: state.platformDatabaseId ?? null,
    scriptNames: tenantIds.map((id) => `t-${id}`),
  });
  const cost = costPerTenantMonth({ windowMs, tenants: tenantIds.length, runs: all.length, ...sums, prices });

  const criteria = [
    { name: "No missed scheduler runs", value: missed, target: `${targets.missedRuns}`, pass: missed <= targets.missedRuns },
    { name: "Queue lag under a minute (max)", value: lagMax, target: `< ${targets.queueLagMaxMs} ms`, pass: all.length > 0 && lagMax < targets.queueLagMaxMs },
    { name: "Runs without a clean answer", value: errors.length, target: `${targets.runErrors}`, pass: errors.length <= targets.runErrors },
    { name: "/__health answered ok", value: `${health.length - healthFailures.length} of ${health.length}`, target: "every check", pass: health.length > 0 && healthFailures.length <= targets.healthFailures },
    {
      name: "Cost per tenant a month",
      value: cost?.total ?? null,
      target: `<= $${targets.costPerTenantMonth.toFixed(2)}`,
      pass: cost?.total === null || cost?.total === undefined ? null : cost.total <= targets.costPerTenantMonth,
    },
  ];
  const verdict = criteria.some((c) => c.pass === false) ? "fail" : criteria.some((c) => c.pass === null) ? "incomplete" : "pass";

  const perTenant = (n) => (n === null || n === undefined ? null : n / tenantIds.length);
  return {
    verdict,
    criteria,
    window: { start: windowStart, end: windowEnd, minutes: Math.round(windowMs / MINUTE_MS) },
    tenants: tenantIds.length,
    monitorsPerTenant: state.monitorsPerTenant,
    runs: {
      total: all.length,
      expected: Math.floor(windowMs / intervalMs) * tenantIds.length,
      missed,
      worst: worst.slice(0, 10),
      errors: { total: errors.length, byOutcome: countBy(errors, (r) => r.outcome) },
      checked: all.reduce((n, r) => n + r.checked, 0),
      failedChecks: all.reduce((n, r) => n + r.failures, 0),
    },
    queueLagMs: { p50: percentile(lags, 50), p95: percentile(lags, 95), max: lagMax },
    durationMs: { p50: percentile(durations, 50), p95: percentile(durations, 95), max: durations.length ? Math.max(...durations) : null },
    platform: {
      minutes: minutes.length,
      runs: minutes.reduce((n, m) => n + m.runs, 0),
      errors: minutes.reduce((n, m) => n + m.errors, 0),
      timeouts: minutes.reduce((n, m) => n + m.timeouts, 0),
      busy: minutes.reduce((n, m) => n + m.busy, 0),
    },
    health: { checks: health.length, failures: healthFailures.length, failingChecks },
    d1PerTenant: sums.d1 ? { rowsRead: perTenant(sums.d1.rowsRead), rowsWritten: perTenant(sums.d1.rowsWritten) } : null,
    platformD1: sums.platformD1,
    cpu: sums.workers
      ? { requests: sums.workers.requests, errors: sums.workers.errors, p50Us: percentile(sums.workers.cpuP50Us, 50), p99Us: percentile(sums.workers.cpuP99Us, 99), cpuMsPerTenant: perTenant(sums.workers.cpuMs) }
      : null,
    cost,
    budget: targets.costPerTenantMonth,
  };
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

const ms = (n) => (n === null || n === undefined ? "n/a" : `${Math.round(n).toLocaleString("en-US")} ms`);
const num = (n, digits = 0) => (n === null || n === undefined ? "not measured" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const dollars = (n) => (n === null || n === undefined ? "not measured" : `$${n.toFixed(n < 0.1 ? 4 : 2)}`);

/** The report as Markdown, one sentence per line. */
export function renderReport(r) {
  const out = [];
  out.push(`# Load test report: ${r.verdict.toUpperCase()}`, "");
  out.push(`${r.tenants} tenants with ${r.monitorsPerTenant} monitors each, measured over ${r.window.minutes} minutes from ${new Date(r.window.start).toISOString()} to ${new Date(r.window.end).toISOString()}.`, "");
  out.push("| Target | Measured | Wanted | Result |", "| --- | --- | --- | --- |");
  for (const c of r.criteria) {
    const value = c.name.startsWith("Queue lag") ? ms(c.value) : c.name.startsWith("Cost") ? dollars(c.value) : String(c.value);
    out.push(`| ${c.name} | ${value} | ${c.target} | ${c.pass === null ? "not measured" : c.pass ? "pass" : "FAIL"} |`);
  }
  out.push("", "## Scheduler", "");
  out.push(`- Runs seen: ${r.runs.total} of about ${r.runs.expected} expected; missed: ${r.runs.missed}.`);
  out.push(`- Queue lag: p50 ${ms(r.queueLagMs.p50)}, p95 ${ms(r.queueLagMs.p95)}, max ${ms(r.queueLagMs.max)}.`);
  out.push(`- Call duration: p50 ${ms(r.durationMs.p50)}, p95 ${ms(r.durationMs.p95)}, max ${ms(r.durationMs.max)}.`);
  out.push(`- Runs without a clean answer: ${r.runs.errors.total}${r.runs.errors.total ? ` (${Object.entries(r.runs.errors.byOutcome).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}.`);
  out.push(`- Checks: ${r.runs.checked}, of which ${r.runs.failedChecks} failed (the echo Worker fails some on purpose).`);
  out.push(`- The platform's own minutes (scheduler_minutes, every tenant): ${r.platform.runs} runs, ${r.platform.errors} errors, ${r.platform.timeouts} timeouts, ${r.platform.busy} busy, over ${r.platform.minutes} minutes.`);
  if (r.runs.worst.length) out.push(`- Tenants with missed runs: ${r.runs.worst.map((w) => `${w.slug} (${w.missed} missed, ${w.runs} seen)`).join(", ")}.`);
  out.push("", "## Health", "");
  out.push(`- /__health answered ok ${r.health.checks - r.health.failures} times of ${r.health.checks}.`);
  if (r.health.failures) out.push(`- Failing checks: ${Object.entries(r.health.failingChecks).map(([k, v]) => `${k} ${v} times`).join(", ") || "none named (no answer or not 200)"}.`);
  out.push("", "## Usage and cost", "");
  out.push(`- Tenant D1 rows per tenant in the window: ${num(r.d1PerTenant?.rowsWritten)} written, ${num(r.d1PerTenant?.rowsRead)} read.`);
  out.push(`- Platform D1 in the window: ${num(r.platformD1?.rowsWritten)} written, ${num(r.platformD1?.rowsRead)} read.`);
  out.push(`- Tenant Worker requests: ${num(r.cpu?.requests)}; CPU per request p50 ${r.cpu ? `${num(r.cpu.p50Us / 1000, 1)} ms` : "not measured"}, p99 ${r.cpu ? `${num(r.cpu.p99Us / 1000, 1)} ms` : "not measured"}.`);
  if (r.cost) {
    out.push(`- Estimated cost per tenant a month: ${dollars(r.cost.total)} against the cost model's $${r.budget.toFixed(2)} (docs/HOSTED_PLAN.md).`);
    out.push(`- By item: ${Object.entries(r.cost.lines).map(([k, v]) => `${k} ${dollars(v)}`).join(", ")}.`);
    out.push("- These are prices past the included allowances, the cost model's convention; CPU uses the p99 per request, so it is a ceiling.");
  }
  out.push("- A new tenant's database has no history yet, so its reads are lower than a months-old install's; the cost model's numbers are for a two-month-old one.");
  return out.join("\n") + "\n";
}
