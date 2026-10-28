import type { Env } from "../types";
import { computeUptimeFromRows } from "./metrics";

/**
 * Per-monitor figures for the Monitors list (GET /api/monitors?include=stats):
 * 7-day uptime, a typical response time and the latest incident. Two D1 reads
 * for every monitor at once, whatever the monitor count.
 *
 * "Typical response" is the median of the hourly average response times over
 * the same 7 days. Raw samples are kept for only a day, so a true 7-day median
 * isn't available; the median of hourly means still ignores the odd slow hour,
 * which an average would not, and it covers the week for monitors that only
 * run on weekdays.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One monitor's list figures. */
export interface MonitorListStats {
  /** Uptime percentage over the last 7 days (100 when nothing was checked). */
  uptime7d: number;
  /** Checks counted in that window; 0 means "no data", not "always up". */
  checks7d: number;
  /** Median of the hourly average response times (ms), or null without data. */
  typicalResponseMs: number | null;
  /** When the most recent incident started, or null when it never had one. */
  lastIncidentAt: number | null;
  /** Whether an incident is open right now. */
  incidentOpen: boolean;
}

/** An hourly summary row as {@link hourlyRowsStatement} selects it. */
export interface HourlyStatsRow {
  monitor_id: string;
  checks: number;
  ok_checks: number;
  monitored_seconds: number;
  down_seconds: number;
  sum_latency_ms: number;
}

/** A per-monitor incident row as {@link lastIncidentStatement} selects it. */
export interface LastIncidentRow {
  monitor_id: string;
  last_started_at: number | null;
  open_count: number;
}

/** Median of a list of numbers (mean of the middle two for an even count). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Every monitor's hourly summaries over the last 7 days. */
export function hourlyRowsStatement(env: Env, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT monitor_id, checks, ok_checks, monitored_seconds, down_seconds, sum_latency_ms
       FROM summaries
      WHERE period = 'hour' AND bucket_start >= ? AND bucket_start <= ?`,
  ).bind(now - WEEK_MS, now);
}

/** Every monitor's latest incident start and open-incident count. */
export function lastIncidentStatement(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT monitor_id, MAX(started_at) AS last_started_at,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count
       FROM incidents
      GROUP BY monitor_id`,
  );
}

/**
 * PURE. Fold the two reads into one entry per monitor id in `monitorIds`
 * (monitors with no rows get 100% uptime, no response time, no incident).
 */
export function buildListStats(
  monitorIds: string[],
  hourly: HourlyStatsRow[],
  incidents: LastIncidentRow[],
): Record<string, MonitorListStats> {
  const hoursByMonitor = new Map<string, HourlyStatsRow[]>();
  for (const row of hourly) {
    const list = hoursByMonitor.get(row.monitor_id);
    if (list) list.push(row);
    else hoursByMonitor.set(row.monitor_id, [row]);
  }
  const incidentByMonitor = new Map(incidents.map((r) => [r.monitor_id, r]));

  const out: Record<string, MonitorListStats> = {};
  for (const id of monitorIds) {
    const rows = hoursByMonitor.get(id) ?? [];
    const uptime = computeUptimeFromRows(
      rows.map((r) => ({
        checks: Number(r.checks) || 0,
        ok_checks: Number(r.ok_checks) || 0,
        monitored_seconds: Number(r.monitored_seconds) || 0,
        down_seconds: Number(r.down_seconds) || 0,
      })),
    );
    // Only hours with a measured response count (heartbeat and domain checks
    // carry no latency, so their sum stays 0).
    const hourlyMeans = rows
      .filter((r) => Number(r.ok_checks) > 0 && Number(r.sum_latency_ms) > 0)
      .map((r) => Number(r.sum_latency_ms) / Number(r.ok_checks));
    const typical = median(hourlyMeans);
    const inc = incidentByMonitor.get(id);
    out[id] = {
      uptime7d: uptime.uptimePct,
      checks7d: uptime.checks,
      typicalResponseMs: typical == null ? null : Math.round(typical),
      lastIncidentAt: inc?.last_started_at ?? null,
      incidentOpen: (Number(inc?.open_count) || 0) > 0,
    };
  }
  return out;
}

/** The list figures for `monitorIds` at `now` (two D1 reads in one batch). */
export async function computeListStats(
  env: Env,
  monitorIds: string[],
  now: number = Date.now(),
): Promise<Record<string, MonitorListStats>> {
  const [hourRes, incRes] = await env.DB.batch([
    hourlyRowsStatement(env, now),
    lastIncidentStatement(env),
  ]);
  return buildListStats(
    monitorIds,
    (hourRes?.results ?? []) as HourlyStatsRow[],
    (incRes?.results ?? []) as LastIncidentRow[],
  );
}
