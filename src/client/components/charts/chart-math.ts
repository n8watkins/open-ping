import { DAY_MS, type BucketState } from "../../../shared/time-range";

/**
 * Pure helpers shared by the hand-built SVG charts: outlier detection, axis
 * scales, bucket merging for narrow screens and bucket labels.
 */

/** Ascending-sorted copy with non-finite values removed. */
function sortedFinite(values: number[]): number[] {
  return values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/**
 * The response time above which a value is an outlier, such as a cold start:
 * beyond the far fence (Q3 + 3 IQR) and more than three times the median.
 * Infinity when there are too few values to judge (fewer than 5).
 */
export function outlierThreshold(values: number[]): number {
  const sorted = sortedFinite(values);
  if (sorted.length < 5) return Infinity;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const median = quantile(sorted, 0.5);
  return Math.max(q3 + 3 * (q3 - q1), median * 3);
}

/** A round axis maximum at or above `value`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base + 1e-9) return step * base;
  }
  return 10 * base;
}

/**
 * Round ticks from 0 to a {@link niceCeil} maximum: quarters of a 1 or 2
 * (0, 250, 500, 750, 1000) and fifths of a 2.5 or 5 (0, 1, 2, 3, 4, 5), so every
 * label is a round number.
 */
export function niceTicks(max: number): number[] {
  const lead = max / 10 ** Math.floor(Math.log10(max));
  const count = Math.abs(lead - 2.5) < 1e-9 || Math.abs(lead - 5) < 1e-9 ? 5 : 4;
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

/** Compact axis label for a response time: "250 ms", "1 s", "1.5 s". */
export function formatAxisMs(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** Most serious first; the order a merged bucket takes its state from. */
export const SEVERITY: BucketState[] = [
  "down",
  "suspended",
  "degraded",
  "maintenance",
  "up",
  "scheduled_off",
  "paused",
  "nodata",
];

const RANK = new Map(SEVERITY.map((s, i) => [s, i]));

export function worstState(states: BucketState[]): BucketState {
  let best: BucketState = "nodata";
  for (const s of states) if ((RANK.get(s) ?? 99) < (RANK.get(best) ?? 99)) best = s;
  return best;
}

/** The fields the strip and tooltips read from a bucket. */
export interface StripBucket {
  t: number;
  state: BucketState;
  checks: number;
  okChecks: number;
  uptime: number | null;
  avgMs: number | null;
  /** How many monitors were in each state (install-wide buckets only). */
  monitors?: Partial<Record<BucketState, number>>;
}

/** A bucket after merging: it may span several source buckets. */
export interface MergedBucket extends StripBucket {
  /** Span in source buckets. */
  span: number;
}

/**
 * Merge every `k` consecutive buckets into one so a long range fits a narrow
 * strip: the most serious state wins, checks add up and the average is
 * weighted by OK checks. Per-monitor counts are kept only when k is 1.
 */
export function mergeBuckets(buckets: StripBucket[], k: number): MergedBucket[] {
  const step = Math.max(1, Math.floor(k));
  if (step === 1) return buckets.map((b) => ({ ...b, span: 1 }));
  const out: MergedBucket[] = [];
  // Align groups to the end, so the current bucket always closes the last group.
  const offset = buckets.length % step;
  for (let i = offset === 0 ? 0 : offset - step; i < buckets.length; i += step) {
    const group = buckets.slice(Math.max(0, i), i + step);
    if (group.length === 0) continue;
    let checks = 0;
    let okChecks = 0;
    let latencySum = 0;
    let latencyN = 0;
    for (const b of group) {
      checks += b.checks;
      okChecks += b.okChecks;
      if (b.avgMs != null) {
        latencySum += b.avgMs * b.okChecks;
        latencyN += b.okChecks;
      }
    }
    out.push({
      t: group[0]!.t,
      state: worstState(group.map((b) => b.state)),
      checks,
      okChecks,
      uptime: checks > 0 ? (okChecks / checks) * 100 : null,
      avgMs: latencyN > 0 ? latencySum / latencyN : null,
      span: group.length,
    });
  }
  return out;
}

/** Contiguous off-hours runs as [start, end) time spans, for chart shading. */
export function offHourBands(
  buckets: { t: number; state: BucketState }[],
  bucketMs: number,
): { start: number; end: number }[] {
  const bands: { start: number; end: number }[] = [];
  for (const b of buckets) {
    if (b.state !== "scheduled_off") continue;
    const last = bands.at(-1);
    if (last && last.end === b.t) last.end = b.t + bucketMs;
    else bands.push({ start: b.t, end: b.t + bucketMs });
  }
  return bands;
}

/**
 * When a bucket covers, in words. Hour buckets in the viewer's time zone
 * ("Tue, Oct 27, 3 PM - 6 PM"); day buckets are UTC days, so they are named
 * by their UTC date ("Tue, Oct 27").
 */
export function bucketLabel(t: number, bucketMs: number, span = 1): string {
  const end = t + bucketMs * span;
  if (bucketMs >= DAY_MS) {
    const day = (ts: number) =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(ts);
    return span > 1 ? `${day(t)} - ${day(end - DAY_MS)}` : day(t);
  }
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(t);
  const time = (ts: number) =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ts);
  return `${date}, ${time(t)} - ${time(end)}`;
}

/** Short axis label for a time: an hour ("3 PM") or a date ("Oct 27", UTC for day grids). */
export function axisLabel(t: number, bucketMs: number, rangeMs: number): string {
  if (bucketMs >= DAY_MS) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(t);
  }
  if (rangeMs > DAY_MS) {
    // "Thu 22": some locales would otherwise put the day number first.
    const parts = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).formatToParts(t);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("weekday")} ${part("day")}`;
  }
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(t);
}
