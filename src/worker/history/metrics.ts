import type { Env } from "../types";

/**
 * Uptime % and incident metrics (PRD §11, §16). All timestamps are epoch
 * milliseconds; computed durations are reported in seconds to match the
 * `duration_seconds` / `*_seconds` columns in the schema.
 *
 * Scheduled-off time is never recorded as a check/summary in the first place
 * (the scheduler simply skips those windows), so summing `summaries` rows
 * inherently excludes scheduled-off time — there is nothing to subtract here.
 */

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

export interface UptimeResult {
  /** ok_checks / checks * 100, or 100 when there are no checks in range. */
  uptimePct: number;
  checks: number;
  okChecks: number;
  monitoredSeconds: number;
  downSeconds: number;
}

/** Minimal shape of a `summaries` row needed to compute uptime. */
interface SummaryUptimeRow {
  checks: number;
  ok_checks: number;
  monitored_seconds: number;
  down_seconds: number;
}

/**
 * Pure reducer over summary rows. Sums the counters and derives uptime %.
 * uptimePct = checks > 0 ? okChecks / checks * 100 : 100 (no checks ⇒ treated
 * as fully up, since there was nothing to observe — e.g. scheduled-off only).
 */
export function computeUptimeFromRows(
  rows: {
    checks: number;
    ok_checks: number;
    monitored_seconds: number;
    down_seconds: number;
  }[],
): UptimeResult {
  let checks = 0;
  let okChecks = 0;
  let monitoredSeconds = 0;
  let downSeconds = 0;

  for (const r of rows) {
    checks += r.checks;
    okChecks += r.ok_checks;
    monitoredSeconds += r.monitored_seconds;
    downSeconds += r.down_seconds;
  }

  const uptimePct = checks > 0 ? (okChecks / checks) * 100 : 100;
  return { uptimePct, checks, okChecks, monitoredSeconds, downSeconds };
}

/**
 * Windows up to this length are summed from the finest ('hour') summaries.
 * Hourly rows are pruned after ~35d, so anything longer must use 'day' rows.
 */
const HOURLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute uptime for a monitor over the window [sinceMs, now].
 *
 * WINDOWING: short windows (≤ 30d) sum the finest 'hour' summaries; longer
 * windows (e.g. the 365-day bar) sum 'day' summaries, which are retained well
 * past the hourly horizon. We never mix periods in one query, so there is no
 * double-counting. Day summaries are kept current by the per-cycle compaction
 * pass, so the most recent day is fresh to within one run.
 */
export async function computeUptime(
  env: Env,
  monitorId: string,
  sinceMs: number,
  now: number,
): Promise<UptimeResult> {
  const period: "hour" | "day" =
    now - sinceMs > HOURLY_WINDOW_MS ? "day" : "hour";
  const res = await env.DB.prepare(
    `SELECT checks, ok_checks, monitored_seconds, down_seconds
       FROM summaries
      WHERE monitor_id = ?
        AND period = ?
        AND bucket_start >= ?
        AND bucket_start <= ?`,
  )
    .bind(monitorId, period, sinceMs, now)
    .all<SummaryUptimeRow>();

  return computeUptimeFromRows(res.results ?? []);
}

// ---------------------------------------------------------------------------
// Incident metrics (MTBF / MTTR / longest / most-recent)
// ---------------------------------------------------------------------------

export interface IncidentMetrics {
  totalIncidents: number;
  totalDowntimeSeconds: number;
  /** Mean seconds between consecutive incident starts; null if < 2 incidents. */
  mtbfSeconds: number | null;
  /** Mean resolved-incident duration in seconds; null if none resolved. */
  mttrSeconds: number | null;
  /** Longest incident duration in seconds; null if no incidents. */
  longestSeconds: number | null;
  /** Most recent incident start (epoch ms); null if no incidents. */
  mostRecentAt: number | null;
}

interface IncidentInput {
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
}

/**
 * Effective downtime (seconds) for an incident: prefer the stored
 * duration_seconds; otherwise derive from resolved_at, or treat an open
 * incident as ongoing up to `now`. Never negative.
 */
function effectiveDuration(inc: IncidentInput, now: number): number {
  if (inc.durationSeconds != null) return inc.durationSeconds;
  const end = inc.resolvedAt != null ? inc.resolvedAt : now;
  return Math.max(0, Math.floor((end - inc.startedAt) / 1000));
}

/** Pure reducer over incident rows — see field docs on IncidentMetrics. */
export function computeIncidentMetricsFromRows(
  incidents: IncidentInput[],
  now: number,
): IncidentMetrics {
  const totalIncidents = incidents.length;
  if (totalIncidents === 0) {
    return {
      totalIncidents: 0,
      totalDowntimeSeconds: 0,
      mtbfSeconds: null,
      mttrSeconds: null,
      longestSeconds: null,
      mostRecentAt: null,
    };
  }

  let totalDowntimeSeconds = 0;
  let longestSeconds = 0;
  let mostRecentAt = -Infinity;

  let resolvedCount = 0;
  let resolvedDowntimeSum = 0;

  for (const inc of incidents) {
    const dur = effectiveDuration(inc, now);
    totalDowntimeSeconds += dur;
    if (dur > longestSeconds) longestSeconds = dur;
    if (inc.startedAt > mostRecentAt) mostRecentAt = inc.startedAt;
    if (inc.resolvedAt != null) {
      resolvedCount += 1;
      resolvedDowntimeSum += dur;
    }
  }

  // MTBF: mean gap between consecutive incident starts (needs ≥ 2 incidents).
  let mtbfSeconds: number | null = null;
  if (totalIncidents >= 2) {
    const starts = incidents.map((i) => i.startedAt).sort((a, b) => a - b);
    let gapSum = 0;
    for (let i = 1; i < starts.length; i++) {
      gapSum += starts[i] - starts[i - 1];
    }
    mtbfSeconds = gapSum / (starts.length - 1) / 1000;
  }

  const mttrSeconds =
    resolvedCount > 0 ? resolvedDowntimeSum / resolvedCount : null;

  return {
    totalIncidents,
    totalDowntimeSeconds,
    mtbfSeconds,
    mttrSeconds,
    longestSeconds,
    mostRecentAt,
  };
}

/** Raw shape of the `incidents` columns we need. */
interface IncidentRow {
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
}

/** Load a monitor's incidents and compute aggregate metrics. */
export async function computeIncidentMetrics(
  env: Env,
  monitorId: string,
  now: number,
): Promise<IncidentMetrics> {
  const res = await env.DB.prepare(
    `SELECT started_at, resolved_at, duration_seconds
       FROM incidents
      WHERE monitor_id = ?
      ORDER BY started_at`,
  )
    .bind(monitorId)
    .all<IncidentRow>();

  const incidents: IncidentInput[] = (res.results ?? []).map((r) => ({
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    durationSeconds: r.duration_seconds,
  }));

  return computeIncidentMetricsFromRows(incidents, now);
}
