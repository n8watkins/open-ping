/**
 * The history ranges the Overview and monitor pages can show, shared by the
 * worker (which buckets the data) and the client (which draws it).
 *
 * Short ranges use hour buckets from the hourly summaries (kept 64 days);
 * long ranges use UTC day buckets from the daily summaries (kept 400 days).
 * Bucket starts are aligned to UTC hours or UTC midnights, so they line up with
 * the `summaries.bucket_start` values exactly and never split a stored row.
 */

export const TIME_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface RangeSpec {
  /** Which summaries tier the buckets come from. */
  period: "hour" | "day";
  bucketMs: number;
  /** Number of buckets; the last one is the current, partial hour or day. */
  buckets: number;
  /** Short label for the range control. */
  short: string;
  /** Long label for headings and screen readers. */
  long: string;
}

export const RANGE_SPEC: Record<TimeRange, RangeSpec> = {
  "24h": { period: "hour", bucketMs: HOUR_MS, buckets: 24, short: "24h", long: "Last 24 hours" },
  "7d": { period: "hour", bucketMs: HOUR_MS, buckets: 168, short: "7d", long: "Last 7 days" },
  "30d": { period: "day", bucketMs: DAY_MS, buckets: 30, short: "30d", long: "Last 30 days" },
  "90d": { period: "day", bucketMs: DAY_MS, buckets: 90, short: "90d", long: "Last 90 days" },
};

export function isTimeRange(value: unknown): value is TimeRange {
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value);
}

/** The range named by `value`, or `fallback` when it is missing or unknown. */
export function parseTimeRange(value: unknown, fallback: TimeRange = "7d"): TimeRange {
  return isTimeRange(value) ? value : fallback;
}

/**
 * The bucket grid for a range ending at `now`: `from` is the first bucket's
 * start and `to` the end of the last (current) bucket. PURE.
 */
export function rangeBounds(
  range: TimeRange,
  now: number,
): { from: number; to: number; bucketMs: number; starts: number[] } {
  const { bucketMs, buckets } = RANGE_SPEC[range];
  const current = now - (((now % bucketMs) + bucketMs) % bucketMs);
  const from = current - (buckets - 1) * bucketMs;
  const starts = Array.from({ length: buckets }, (_, i) => from + i * bucketMs);
  return { from, to: current + bucketMs, bucketMs, starts };
}

/**
 * What one bucket of history looked like. A monitor state, or "nodata" when
 * nothing was observed (before the monitor existed, or a gap). Off-hours
 * (`scheduled_off`) is its own neutral state and never counts as downtime.
 */
export type BucketState =
  | "up"
  | "degraded"
  | "down"
  | "suspended"
  | "scheduled_off"
  | "maintenance"
  | "paused"
  | "cant_check"
  | "nodata";

/** One bucket of a monitor's (or the whole install's) history. */
export interface RangeBucket {
  /** Bucket start, epoch ms. */
  t: number;
  state: BucketState;
  checks: number;
  okChecks: number;
  /** okChecks / checks * 100, or null when there were no checks. */
  uptime: number | null;
  /** Mean response time of the OK checks, or null when none. */
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** Seconds of the bucket spent in each notable state (from status intervals). */
  downSeconds: number;
  suspendedSeconds: number;
  degradedSeconds: number;
  offSeconds: number;
  maintenanceSeconds: number;
}

/** An aggregate bucket across monitors: how many monitors were in each state. */
export interface OverviewBucket extends RangeBucket {
  monitors: Partial<Record<BucketState, number>>;
}

export interface LatencyStats {
  avg: number | null;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  /**
   * What the percentiles were taken over: individual checks (24h, from the raw
   * samples), or hourly / daily averages (longer ranges, where only the
   * summaries remain).
   */
  basis: "checks" | "hourly" | "daily";
  /** How many values the stats cover. */
  count: number;
}

export interface RangeTotals {
  /** Range uptime %, or null when the range had no checks. */
  uptimePct: number | null;
  checks: number;
  okChecks: number;
  /** Seconds down or suspended in the range (suspended is a subset). */
  downtimeSeconds: number;
  suspendedSeconds: number;
  /** Number of separate suspended periods in the range. */
  suspensions: number;
  offSeconds: number;
  latency: LatencyStats;
}

export interface MonitorRangeHistory extends RangeTotals {
  id: string;
  buckets: RangeBucket[];
}

/** The fields of a bucket the Overview's monitor cards draw. */
export type CompactBucket = Pick<RangeBucket, "t" | "state" | "checks" | "okChecks" | "uptime" | "avgMs">;

export interface MonitorRangeSummary extends RangeTotals {
  id: string;
  buckets: CompactBucket[];
}

export interface RangeIncident {
  id: string;
  monitorId: string;
  monitorName: string | null;
  status: "open" | "resolved";
  title: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  error: string | null;
}

/** GET /api/overview/history?range= */
export interface OverviewHistoryResponse {
  range: TimeRange;
  from: number;
  to: number;
  now: number;
  bucketMs: number;
  overall: RangeTotals & { buckets: OverviewBucket[] };
  monitors: MonitorRangeSummary[];
  incidents: RangeIncident[];
  incidentCount: number;
}

/** One response-time point for the monitor chart. */
export interface LatencyPoint {
  t: number;
  ms: number;
}

/** GET /api/monitors/:id/history?range= */
export interface MonitorHistoryResponse extends MonitorRangeHistory {
  range: TimeRange;
  from: number;
  to: number;
  now: number;
  bucketMs: number;
  /**
   * The response-time series: every OK check for 24h, otherwise the average of
   * each bucket that had OK checks.
   */
  points: LatencyPoint[];
  incidentCount: number;
}
