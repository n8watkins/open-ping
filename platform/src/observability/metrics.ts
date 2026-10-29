/**
 * Platform-wide scheduler metrics (build plan, C4): every tenant run, added
 * up per UTC minute in `scheduler_minutes` (migration 0010), for the admin
 * console's Operations tab.
 *
 * Written once per queue consumer batch (up to 25 runs: one upsert per minute
 * the batch's runs started in, almost always one), never once per run, so the
 * cost is about 1/25 of a D1 row written per run (platform/README.md,
 * "Observability costs").
 *
 * Read by ranges of the table's integer primary key: a window of the last
 * hour reads at most 60 rows and a day 1,440, however many tenants there are.
 * The p95 duration comes from fixed duration buckets, so it is "at most this
 * bucket's upper bound", which is what an owner needs to see a slowdown, and
 * costs nothing per run to keep.
 */

import type { RunOutcome } from "../scheduling";

/** The duration buckets' upper bounds (ms): d0 is up to 250 ms, ..., d8 up to 60 s, d9 anything slower. */
export const DURATION_BUCKETS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
export const BUCKET_COUNT = DURATION_BUCKETS_MS.length + 1;
const BUCKET_COLUMNS = Array.from({ length: BUCKET_COUNT }, (_, i) => `d${i}`);

export const MINUTE_MS = 60_000;
/** scheduler_minutes keeps this many days (the console shows a day; a week back is for comparing). */
export const MINUTES_KEPT_DAYS = 8;

/** What one run adds to its minute. */
export interface RunSample {
  /** When the platform called the tenant (epoch ms). */
  at: number;
  outcome: RunOutcome;
  durationMs: number;
  lagMs: number;
  checked: number;
  failures: number;
}

export function bucketOf(durationMs: number): number {
  const i = DURATION_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
  return i === -1 ? DURATION_BUCKETS_MS.length : i;
}

const isError = (o: RunOutcome) => o !== "ran" && o !== "lease_busy";

const RECORD_MINUTE_SQL = `INSERT INTO scheduler_minutes (minute, runs, errors, timeouts, busy, checked, failures, total_ms, max_ms, lag_total_ms, lag_max_ms, ${BUCKET_COLUMNS.join(", ")})
  VALUES (${Array.from({ length: 11 + BUCKET_COUNT }, (_, i) => `?${i + 1}`).join(", ")})
  ON CONFLICT(minute) DO UPDATE SET
    runs = runs + excluded.runs, errors = errors + excluded.errors, timeouts = timeouts + excluded.timeouts,
    busy = busy + excluded.busy, checked = checked + excluded.checked, failures = failures + excluded.failures,
    total_ms = total_ms + excluded.total_ms, max_ms = MAX(max_ms, excluded.max_ms),
    lag_total_ms = lag_total_ms + excluded.lag_total_ms, lag_max_ms = MAX(lag_max_ms, excluded.lag_max_ms),
    ${BUCKET_COLUMNS.map((d) => `${d} = ${d} + excluded.${d}`).join(", ")}`;

/** One upsert per minute the samples fall in: what a consumer batch writes. */
export function runMinuteStatements(db: D1Database, samples: RunSample[]): D1PreparedStatement[] {
  const byMinute = new Map<number, RunSample[]>();
  for (const s of samples) {
    const minute = Math.floor(s.at / MINUTE_MS);
    const list = byMinute.get(minute);
    if (list) list.push(s);
    else byMinute.set(minute, [s]);
  }
  return [...byMinute].map(([minute, list]) => {
    const buckets = new Array<number>(BUCKET_COUNT).fill(0);
    for (const s of list) buckets[bucketOf(s.durationMs)]!++;
    const sum = (f: (s: RunSample) => number) => list.reduce((n, s) => n + f(s), 0);
    const max = (f: (s: RunSample) => number) => list.reduce((n, s) => Math.max(n, f(s)), 0);
    return db
      .prepare(RECORD_MINUTE_SQL)
      .bind(
        minute,
        list.length,
        list.filter((s) => isError(s.outcome)).length,
        list.filter((s) => s.outcome === "timeout").length,
        list.filter((s) => s.outcome === "lease_busy").length,
        sum((s) => s.checked),
        sum((s) => s.failures),
        sum((s) => s.durationMs),
        max((s) => s.durationMs),
        sum((s) => s.lagMs),
        max((s) => s.lagMs),
        ...buckets,
      );
  });
}

/** A range over the integer primary key, so it reads only the minutes it deletes. */
export const OLD_MINUTES_SQL = "DELETE FROM scheduler_minutes WHERE minute < ?";

/** Once an hour from the cron: forget minutes older than MINUTES_KEPT_DAYS. */
export function schedulerMinutesCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare(OLD_MINUTES_SQL).bind(Math.floor(now / MINUTE_MS) - MINUTES_KEPT_DAYS * 1440);
}

// ---------------------------------------------------------------------------
// Reading: windows and the last day by hour
// ---------------------------------------------------------------------------

/** Totals over [from, to) minutes: a primary key range, at most one row per minute. */
export const WINDOW_SQL = `SELECT COUNT(*) AS minutes, COALESCE(SUM(runs), 0) AS runs, COALESCE(SUM(errors), 0) AS errors,
    COALESCE(SUM(timeouts), 0) AS timeouts, COALESCE(SUM(busy), 0) AS busy, COALESCE(SUM(checked), 0) AS checked,
    COALESCE(SUM(failures), 0) AS failures, COALESCE(SUM(total_ms), 0) AS total_ms, COALESCE(MAX(max_ms), 0) AS max_ms,
    COALESCE(SUM(lag_total_ms), 0) AS lag_total_ms, COALESCE(MAX(lag_max_ms), 0) AS lag_max_ms,
    ${BUCKET_COLUMNS.map((d) => `COALESCE(SUM(${d}), 0) AS ${d}`).join(", ")}
  FROM scheduler_minutes WHERE minute >= ?1 AND minute < ?2`;

/** The oldest minute kept: where the data starts, the table's first primary key. */
export const FIRST_MINUTE_SQL = "SELECT MIN(minute) AS minute FROM scheduler_minutes";

/** The same range, by hour: at most 24 groups for a day. */
export const HOURS_SQL = `SELECT minute / 60 AS hour, SUM(runs) AS runs, SUM(errors) AS errors, SUM(total_ms) AS total_ms,
    MAX(max_ms) AS max_ms, MAX(lag_max_ms) AS lag_max_ms
  FROM scheduler_minutes WHERE minute >= ?1 AND minute < ?2 GROUP BY minute / 60 ORDER BY hour`;

export interface RunWindow {
  /** The window's length in minutes (complete minutes, ending at the last full one). */
  minutes: number;
  runs: number;
  /** Over the window, or over the minutes since its first recorded run when that is shorter. */
  runsPerMinute: number;
  errors: number;
  timeouts: number;
  busy: number;
  checked: number;
  failures: number;
  avgMs: number;
  maxMs: number;
  /** The upper bound of the bucket the 95th percentile run falls in; null when no runs, or slower than the last bound. */
  p95Ms: number | null;
  /** True when the 95th percentile is slower than the last bound (60 s). */
  p95Over: boolean;
  avgLagMs: number;
  maxLagMs: number;
}

export interface RunHour {
  /** The hour's start (epoch ms). */
  at: number;
  runs: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  maxLagMs: number;
}

/** The bucket bound the `q` quantile falls in, from bucket counts. */
export function quantileFromBuckets(counts: number[], q: number): { ms: number | null; over: boolean } {
  const total = counts.reduce((n, c) => n + c, 0);
  if (total === 0) return { ms: null, over: false };
  const target = Math.ceil(q * total);
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i]!;
    if (seen >= target) return i < DURATION_BUCKETS_MS.length ? { ms: DURATION_BUCKETS_MS[i]!, over: false } : { ms: null, over: true };
  }
  return { ms: null, over: true };
}

type WindowRow = Record<string, number>;

/**
 * The minutes a window's rate is over: the whole window, or, while the
 * table holds less than that (a new platform), the minutes since its first
 * recorded run. A quiet stretch inside the data still counts as minutes.
 */
export function rateMinutes(window: number, to: number, firstMinute: number | null | undefined): number {
  if (firstMinute === null || firstMinute === undefined) return window;
  return Math.max(1, Math.min(window, to - firstMinute));
}

function toWindow(row: WindowRow, minutes: number, to: number, firstMinute: number | null): RunWindow {
  const runs = row.runs ?? 0;
  const over = rateMinutes(minutes, to, firstMinute);
  const p95 = quantileFromBuckets(BUCKET_COLUMNS.map((d) => row[d] ?? 0), 0.95);
  return {
    minutes,
    runs,
    runsPerMinute: runs / over,
    errors: row.errors ?? 0,
    timeouts: row.timeouts ?? 0,
    busy: row.busy ?? 0,
    checked: row.checked ?? 0,
    failures: row.failures ?? 0,
    avgMs: runs ? Math.round((row.total_ms ?? 0) / runs) : 0,
    maxMs: row.max_ms ?? 0,
    p95Ms: p95.ms,
    p95Over: p95.over,
    avgLagMs: runs ? Math.round((row.lag_total_ms ?? 0) / runs) : 0,
    maxLagMs: row.lag_max_ms ?? 0,
  };
}

/** The windows the Operations tab shows, in minutes. */
export const WINDOWS = [15, 60, 1440] as const;

export interface RunMetrics {
  /** The last complete minute's end (epoch ms): every window ends here. */
  until: number;
  windows: RunWindow[];
  /** The last 24 hours by hour, oldest first; hours without runs are absent. */
  hours: RunHour[];
}

/** The Operations tab's numbers: one D1 batch, every statement a primary key range. */
export async function runMetrics(db: D1Database, now: number): Promise<RunMetrics> {
  // Complete minutes only: the current one is still being written.
  const to = Math.floor(now / MINUTE_MS);
  const results = await db.batch<Record<string, number>>([
    ...WINDOWS.map((m) => db.prepare(WINDOW_SQL).bind(to - m, to)),
    db.prepare(HOURS_SQL).bind(to - 1440, to),
    db.prepare(FIRST_MINUTE_SQL),
  ]);
  const first = (results[WINDOWS.length + 1]!.results[0] as { minute?: number | null } | undefined)?.minute ?? null;
  const windows = WINDOWS.map((m, i) => toWindow(results[i]!.results[0] ?? {}, m, to, first));
  const hours = (results[WINDOWS.length]!.results as { hour: number; runs: number; errors: number; total_ms: number; max_ms: number; lag_max_ms: number }[]).map(
    (h): RunHour => ({
      at: h.hour * 3_600_000,
      runs: h.runs,
      errors: h.errors,
      avgMs: h.runs ? Math.round(h.total_ms / h.runs) : 0,
      maxMs: h.max_ms,
      maxLagMs: h.lag_max_ms,
    }),
  );
  return { until: to * MINUTE_MS, windows, hours };
}
