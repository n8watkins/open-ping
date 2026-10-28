import type { Env } from "../types";
import {
  DAY_MS,
  RANGE_SPEC,
  rangeBounds,
  type BucketState,
  type LatencyPoint,
  type LatencyStats,
  type MonitorRangeHistory,
  type OverviewBucket,
  type RangeBucket,
  type RangeIncident,
  type RangeTotals,
  type TimeRange,
} from "../../shared/time-range";

/**
 * Range history (Overview and monitor pages): uptime, state and response time
 * bucketed by hour (24h, 7d) or UTC day (30d, 90d).
 *
 * Two sources are combined per bucket:
 *  - `summaries` rows (the hour or day tier, one row per bucket) give the check
 *    counts and latency, so uptime is ok_checks / checks exactly as elsewhere;
 *  - `status_intervals` (kept 400 days) give how long the monitor spent in each
 *    state, which is what tells an off-hours bucket (neutral gray, no checks by
 *    design) from a gap in the data, and a suspension from an outage.
 *
 * Whatever the monitor count, a load is at most seven D1 reads, run in parallel,
 * well inside the Free plan's 50 queries per invocation.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile of an ascending array; null when empty. PURE. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = sorted[lo]!;
  const hiV = sorted[hi]!;
  return loV + (hiV - loV) * (rank - lo);
}

/** Average, median, p95, min and max of a set of response times. PURE. */
export function latencyStats(values: number[], basis: LatencyStats["basis"]): LatencyStats {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { avg: null, median: null, p95: null, min: null, max: null, basis, count: 0 };
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (v: number | null) => (v == null ? null : Math.round(v));
  return {
    avg: round(sum / sorted.length),
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    basis,
    count: sorted.length,
  };
}

export interface IntervalSpan {
  state: string;
  startedAt: number;
  /** null while the interval is still open (it runs to `now`). */
  endedAt: number | null;
}

/** Seconds per notable state for each bucket. */
export interface StateSeconds {
  up: number;
  down: number;
  suspended: number;
  degraded: number;
  off: number;
  maintenance: number;
  paused: number;
}

const emptySeconds = (): StateSeconds => ({
  up: 0,
  down: 0,
  suspended: 0,
  degraded: 0,
  off: 0,
  maintenance: 0,
  paused: 0,
});

const STATE_KEY: Record<string, keyof StateSeconds | undefined> = {
  up: "up",
  down: "down",
  suspended: "suspended",
  degraded: "degraded",
  scheduled_off: "off",
  maintenance: "maintenance",
  paused: "paused",
};

/**
 * Spread status intervals over a bucket grid: for every bucket, how many
 * seconds fell in each state. Intervals are clipped to [from, now]; an open
 * interval runs to `now`. PURE.
 */
export function distributeIntervals(
  intervals: IntervalSpan[],
  from: number,
  bucketMs: number,
  bucketCount: number,
  now: number,
): StateSeconds[] {
  const out = Array.from({ length: bucketCount }, emptySeconds);
  const gridEnd = from + bucketCount * bucketMs;
  for (const iv of intervals) {
    const key = STATE_KEY[iv.state];
    if (!key) continue;
    const start = Math.max(iv.startedAt, from);
    const end = Math.min(iv.endedAt ?? now, now, gridEnd);
    if (end <= start) continue;
    let i = Math.floor((start - from) / bucketMs);
    let cursor = start;
    while (cursor < end && i < bucketCount) {
      const bucketEnd = from + (i + 1) * bucketMs;
      const segEnd = Math.min(end, bucketEnd);
      out[i]![key] += (segEnd - cursor) / 1000;
      cursor = segEnd;
      i++;
    }
  }
  return out;
}

/**
 * The single state that best describes a bucket, most serious first:
 * an outage or suspension, then failed checks or slowness, then a bucket that
 * was checked and fine. A bucket with no checks is off-hours, maintenance or
 * paused when the intervals say so, and "nodata" otherwise. Off-hours never
 * outranks real checks and is never downtime. PURE.
 */
export function classifyBucket(
  checks: number,
  okChecks: number,
  s: StateSeconds,
): BucketState {
  if (s.down > 0 || s.suspended > 0) return s.suspended > s.down ? "suspended" : "down";
  if (checks > 0 && okChecks < checks) return "degraded";
  if (s.degraded > 0) return "degraded";
  if (checks > 0) return "up";
  if (s.maintenance > 0) return "maintenance";
  if (s.off > 0) return "scheduled_off";
  if (s.paused > 0) return "paused";
  if (s.up > 0) return "up";
  return "nodata";
}

export interface SummaryBucketRow {
  monitor_id: string;
  bucket_start: number;
  checks: number;
  ok_checks: number;
  sum_latency_ms: number;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
}

/** Build one monitor's bucket series from its summary rows and state seconds. PURE. */
export function buildBuckets(
  starts: number[],
  rows: SummaryBucketRow[],
  seconds: StateSeconds[],
): RangeBucket[] {
  const byStart = new Map(rows.map((r) => [Number(r.bucket_start), r]));
  return starts.map((t, i) => {
    const row = byStart.get(t);
    const checks = Math.max(0, Number(row?.checks ?? 0));
    const okChecks = Math.min(checks, Math.max(0, Number(row?.ok_checks ?? 0)));
    // sum_latency_ms counts OK checks only; a bucket whose checks carried no
    // measured latency (a heartbeat) has no max either, so reports none.
    const hasLatency = row?.max_latency_ms != null && okChecks > 0;
    const s = seconds[i] ?? emptySeconds();
    return {
      t,
      state: classifyBucket(checks, okChecks, s),
      checks,
      okChecks,
      uptime: checks > 0 ? (okChecks / checks) * 100 : null,
      avgMs: hasLatency ? Math.round(Number(row!.sum_latency_ms) / okChecks) : null,
      minMs: row?.min_latency_ms ?? null,
      maxMs: row?.max_latency_ms ?? null,
      downSeconds: Math.round(s.down),
      suspendedSeconds: Math.round(s.suspended),
      degradedSeconds: Math.round(s.degraded),
      offSeconds: Math.round(s.off),
      maintenanceSeconds: Math.round(s.maintenance),
    };
  });
}

/** Most serious first: the order an aggregate bucket takes its state from. */
const SEVERITY: BucketState[] = [
  "down",
  "suspended",
  "degraded",
  "maintenance",
  "up",
  "scheduled_off",
  "paused",
  "nodata",
];

/**
 * Fold every monitor's series into one install-wide series (same grid). The
 * aggregate state is the most serious monitor state in the bucket, and
 * `monitors` counts how many monitors were in each. PURE.
 */
export function aggregateBuckets(starts: number[], series: RangeBucket[][]): OverviewBucket[] {
  return starts.map((t, i) => {
    const monitors: Partial<Record<BucketState, number>> = {};
    let checks = 0;
    let okChecks = 0;
    let latencySum = 0;
    let latencyN = 0;
    let minMs: number | null = null;
    let maxMs: number | null = null;
    let downSeconds = 0;
    let suspendedSeconds = 0;
    let degradedSeconds = 0;
    let offSeconds = 0;
    let maintenanceSeconds = 0;
    for (const s of series) {
      const b = s[i];
      if (!b) continue;
      monitors[b.state] = (monitors[b.state] ?? 0) + 1;
      checks += b.checks;
      okChecks += b.okChecks;
      if (b.avgMs != null) {
        latencySum += b.avgMs * b.okChecks;
        latencyN += b.okChecks;
      }
      if (b.minMs != null) minMs = minMs == null ? b.minMs : Math.min(minMs, b.minMs);
      if (b.maxMs != null) maxMs = maxMs == null ? b.maxMs : Math.max(maxMs, b.maxMs);
      downSeconds += b.downSeconds;
      suspendedSeconds += b.suspendedSeconds;
      degradedSeconds += b.degradedSeconds;
      offSeconds += b.offSeconds;
      maintenanceSeconds += b.maintenanceSeconds;
    }
    const state = SEVERITY.find((st) => (monitors[st] ?? 0) > 0) ?? "nodata";
    return {
      t,
      state,
      monitors,
      checks,
      okChecks,
      uptime: checks > 0 ? (okChecks / checks) * 100 : null,
      avgMs: latencyN > 0 ? Math.round(latencySum / latencyN) : null,
      minMs,
      maxMs,
      downSeconds,
      suspendedSeconds,
      degradedSeconds,
      offSeconds,
      maintenanceSeconds,
    };
  });
}

/** Range totals from a bucket series (plus its suspension count and latency). PURE. */
export function totalsFromBuckets(
  buckets: RangeBucket[],
  suspensions: number,
  latency: LatencyStats,
): RangeTotals {
  let checks = 0;
  let okChecks = 0;
  let down = 0;
  let suspended = 0;
  let off = 0;
  for (const b of buckets) {
    checks += b.checks;
    okChecks += b.okChecks;
    down += b.downSeconds;
    suspended += b.suspendedSeconds;
    off += b.offSeconds;
  }
  return {
    uptimePct: checks > 0 ? (okChecks / checks) * 100 : null,
    checks,
    okChecks,
    downtimeSeconds: down + suspended,
    suspendedSeconds: suspended,
    suspensions,
    offSeconds: off,
    latency,
  };
}

/**
 * Downtime in a window from status intervals: total seconds down or
 * suspended, the suspended share, and how many suspended periods touched the
 * window. Used to explain a long-range uptime figure. PURE.
 */
export function downtimeBreakdown(
  intervals: IntervalSpan[],
  from: number,
  now: number,
): { downtimeSeconds: number; suspendedSeconds: number; suspensions: number } {
  let down = 0;
  let suspended = 0;
  let suspensions = 0;
  for (const iv of intervals) {
    if (iv.state !== "down" && iv.state !== "suspended") continue;
    const start = Math.max(iv.startedAt, from);
    const end = Math.min(iv.endedAt ?? now, now);
    if (end <= start) continue;
    const secs = (end - start) / 1000;
    if (iv.state === "suspended") {
      suspended += secs;
      suspensions++;
    } else {
      down += secs;
    }
  }
  return {
    downtimeSeconds: Math.round(down + suspended),
    suspendedSeconds: Math.round(suspended),
    suspensions,
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface IntervalRow {
  monitor_id: string;
  state: string;
  started_at: number;
  ended_at: number | null;
}

interface SampleRow {
  monitor_id: string;
  at: number;
  duration_ms: number;
}

interface IncidentRow {
  id: string;
  monitor_id: string;
  monitor_name: string | null;
  status: string;
  title: string | null;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
  error: string | null;
}

/** Ranges up to this long take latency percentiles from hourly summaries (kept 64 days). */
const HOURLY_LATENCY_MAX_MS = 60 * DAY_MS;

/** How many incidents a range response lists (the count covers them all). */
export const RANGE_INCIDENT_LIMIT = 100;

export interface RangeHistory {
  range: TimeRange;
  from: number;
  to: number;
  now: number;
  bucketMs: number;
  starts: number[];
  monitors: MonitorRangeHistory[];
  /** Install-wide series and totals (over the loaded monitors). */
  overall: RangeTotals & { buckets: OverviewBucket[] };
  /** OK-check response times per monitor; filled for 24h only. */
  samples: Map<string, LatencyPoint[]>;
  incidents: RangeIncident[];
  incidentCount: number;
}

/**
 * Load the range history of every monitor, or of one (`monitorId`). At most
 * seven D1 reads in parallel whatever the monitor count: monitor ids, the
 * summaries in range, the overlapping status intervals, the OK samples (24h
 * only), the hourly latencies (30d only), and the incidents overlapping the
 * range with their count.
 */
export async function loadRangeHistory(
  env: Env,
  range: TimeRange,
  now: number,
  monitorId?: string,
): Promise<RangeHistory> {
  const spec = RANGE_SPEC[range];
  const { from, to, bucketMs, starts } = rangeBounds(range, now);
  const one = monitorId != null;
  const useSamples = range === "24h";

  // Percentiles want the finest data still kept: raw samples for 24h, hourly
  // averages while hourly summaries cover the range (64 days by default), and
  // the day buckets themselves beyond that.
  const hourlyLatency = !useSamples && spec.period === "day" && spec.buckets * DAY_MS <= HOURLY_LATENCY_MAX_MS;

  const [idsRes, summaryRes, intervalRes, sampleRes, hourlyRes, incidentRes, countRow] = await Promise.all([
    (one
      ? env.DB.prepare("SELECT id FROM monitors WHERE id = ?").bind(monitorId)
      : env.DB.prepare("SELECT id FROM monitors ORDER BY created_at")
    ).all<{ id: string }>(),
    env.DB.prepare(
      `SELECT monitor_id, bucket_start, checks, ok_checks, sum_latency_ms,
              min_latency_ms, max_latency_ms
         FROM summaries
        WHERE period = ? AND bucket_start >= ? AND bucket_start < ?
          ${one ? "AND monitor_id = ?" : ""}`,
    )
      .bind(...[spec.period, from, to, ...(one ? [monitorId] : [])])
      .all<SummaryBucketRow>(),
    env.DB.prepare(
      `SELECT monitor_id, state, started_at, ended_at
         FROM status_intervals
        WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
          ${one ? "AND monitor_id = ?" : ""}`,
    )
      .bind(...[to, from, ...(one ? [monitorId] : [])])
      .all<IntervalRow>(),
    useSamples
      ? env.DB.prepare(
          `SELECT monitor_id, at, duration_ms
             FROM samples
            WHERE ok = 1 AND duration_ms IS NOT NULL AND at >= ? AND at <= ?
              ${one ? "AND monitor_id = ?" : ""}
            ORDER BY at`,
        )
          .bind(...[from, now, ...(one ? [monitorId] : [])])
          .all<SampleRow>()
      : Promise.resolve({ results: [] as SampleRow[] }),
    hourlyLatency
      ? env.DB.prepare(
          `SELECT monitor_id, sum_latency_ms, ok_checks
             FROM summaries
            WHERE period = 'hour' AND bucket_start >= ? AND bucket_start < ?
              AND ok_checks > 0 AND max_latency_ms IS NOT NULL
              ${one ? "AND monitor_id = ?" : ""}`,
        )
          .bind(...[from, to, ...(one ? [monitorId] : [])])
          .all<{ monitor_id: string; sum_latency_ms: number; ok_checks: number }>()
      : Promise.resolve({ results: [] as { monitor_id: string; sum_latency_ms: number; ok_checks: number }[] }),
    env.DB.prepare(
      `SELECT i.id, i.monitor_id, m.name AS monitor_name, i.status, i.title,
              i.started_at, i.resolved_at, i.duration_seconds, i.error
         FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id
        WHERE i.started_at <= ? AND (i.resolved_at IS NULL OR i.resolved_at >= ?)
          ${one ? "AND i.monitor_id = ?" : ""}
        ORDER BY i.started_at DESC
        LIMIT ?`,
    )
      .bind(...[now, from, ...(one ? [monitorId] : []), RANGE_INCIDENT_LIMIT])
      .all<IncidentRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM incidents
        WHERE started_at <= ? AND (resolved_at IS NULL OR resolved_at >= ?)
          ${one ? "AND monitor_id = ?" : ""}`,
    )
      .bind(...[now, from, ...(one ? [monitorId] : [])])
      .first<{ c: number }>(),
  ]);

  const summariesBy = groupBy(summaryRes.results ?? [], (r) => r.monitor_id);
  const intervalsBy = groupBy(intervalRes.results ?? [], (r) => r.monitor_id);
  const samplesBy = new Map<string, LatencyPoint[]>();
  for (const s of sampleRes.results ?? []) {
    const list = samplesBy.get(s.monitor_id) ?? [];
    list.push({ t: Number(s.at), ms: Number(s.duration_ms) });
    samplesBy.set(s.monitor_id, list);
  }
  const hourlyBy = new Map<string, number[]>();
  for (const r of hourlyRes.results ?? []) {
    const list = hourlyBy.get(r.monitor_id) ?? [];
    list.push(Number(r.sum_latency_ms) / Number(r.ok_checks));
    hourlyBy.set(r.monitor_id, list);
  }
  const basis: LatencyStats["basis"] = useSamples
    ? "checks"
    : spec.period === "hour" || hourlyLatency
      ? "hourly"
      : "daily";
  const latencyValues = (id: string, buckets: RangeBucket[]): number[] =>
    useSamples
      ? (samplesBy.get(id) ?? []).map((p) => p.ms)
      : hourlyLatency
        ? (hourlyBy.get(id) ?? [])
        : bucketAverages(buckets);

  const monitors: MonitorRangeHistory[] = (idsRes.results ?? []).map(({ id }) => {
    const spans = (intervalsBy.get(id) ?? []).map(toSpan);
    const seconds = distributeIntervals(spans, from, bucketMs, starts.length, now);
    const buckets = buildBuckets(starts, summariesBy.get(id) ?? [], seconds);
    const { suspensions } = downtimeBreakdown(spans, from, now);
    return {
      id,
      buckets,
      ...totalsFromBuckets(buckets, suspensions, latencyStats(latencyValues(id, buckets), basis)),
    };
  });

  const overallBuckets = aggregateBuckets(
    starts,
    monitors.map((m) => m.buckets),
  );
  const overallLatency = latencyStats(
    monitors.flatMap((m) => latencyValues(m.id, m.buckets)),
    basis,
  );
  const overall = {
    ...totalsFromBuckets(
      overallBuckets,
      monitors.reduce((acc, m) => acc + m.suspensions, 0),
      overallLatency,
    ),
    buckets: overallBuckets,
  };

  const incidents: RangeIncident[] = (incidentRes.results ?? []).map((r) => ({
    id: r.id,
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    status: r.status === "open" ? "open" : "resolved",
    title: r.title,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    durationSeconds: r.duration_seconds,
    error: r.error,
  }));

  return {
    range,
    from,
    to,
    now,
    bucketMs,
    starts,
    monitors,
    overall,
    samples: samplesBy,
    incidents,
    incidentCount: Number(countRow?.c ?? incidents.length),
  };
}

function toSpan(r: IntervalRow): IntervalSpan {
  return { state: r.state, startedAt: Number(r.started_at), endedAt: r.ended_at == null ? null : Number(r.ended_at) };
}

function bucketAverages(buckets: RangeBucket[]): number[] {
  return buckets.flatMap((b) => (b.avgMs != null ? [b.avgMs] : []));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}
