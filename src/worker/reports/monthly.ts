import { DateTime } from "luxon";
import type { Env } from "../types";
import type { RetentionConfig } from "../history/rollups";
import { csvCell } from "../routes/incidents";

/**
 * Monthly uptime report (docs/STATUS_PAGES.md, "Monthly uptime report"): per
 * monitor uptime %, downtime minutes, incident count and average response time
 * for one calendar month in the install's timezone.
 *
 * It is computed from the rollups (`summaries`), never from raw samples, in a
 * single summaries query plus one for monitors and one for incident counts, so
 * a report costs three D1 queries (one round trip when batched) whatever the
 * month or the number of monitors.
 *
 * Off-hours: a monitor outside its operating schedule is not checked, so its
 * off-hours time never reaches the rollups. It counts as neither uptime nor
 * downtime, and `monitoredMinutes` shows how much of the month was watched.
 *
 * Which rollup tier: hourly rows are kept for `hourlyDays` (64 by default,
 * so last month is always complete in hourly rows until this month ends),
 * daily rows for `dailyDays` (400), monthly rows forever, all in UTC buckets.
 * Each stretch of the month is read from the finest tier that still holds it
 * completely ({@link tierRanges}). A local month rarely starts on a UTC bucket
 * boundary (Los Angeles months start at 07:00 or 08:00 UTC), so a bucket that
 * straddles the month's start or end counts in proportion to its overlap
 * ({@link reduceReportGroups}). With hourly rows that is exact for every
 * whole-hour timezone; with daily or monthly rows (months older than the hourly
 * horizon, or a shorter custom retention) the edge day or month is prorated,
 * which is the best the retained data allows.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MonthBounds {
  /** "YYYY-MM" */
  month: string;
  timezone: string;
  /** First instant of the month in `timezone` (epoch ms, inclusive). */
  start: number;
  /** First instant of the next month (epoch ms, exclusive). */
  end: number;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for a "YYYY-MM" string from 2000-01 on. */
export function isMonth(value: string): boolean {
  const m = MONTH_RE.exec(value);
  return m != null && Number(m[1]) >= 2000;
}

/** A timezone luxon understands, else UTC. */
export function safeZone(zone: string | null | undefined): string {
  return zone && DateTime.local().setZone(zone).isValid ? zone : "UTC";
}

/**
 * The month's start and end instants in `zone`. Daylight saving changes inside
 * the month are handled by the calendar maths (a Los Angeles March is 743
 * hours long, a November 721).
 */
export function monthBounds(month: string, zone: string): MonthBounds {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`not a YYYY-MM month: ${month}`);
  const timezone = safeZone(zone);
  const start = DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: 1 }, { zone: timezone });
  return { month, timezone, start: start.toMillis(), end: start.plus({ months: 1 }).toMillis() };
}

/** The calendar month before the one `now` falls in, in `zone`: "YYYY-MM". */
export function previousMonth(now: number, zone: string): string {
  return DateTime.fromMillis(now, { zone: safeZone(zone) }).startOf("month").minus({ months: 1 }).toFormat("yyyy-MM");
}

/** The calendar month `now` falls in, in `zone`: "YYYY-MM". */
export function currentMonth(now: number, zone: string): string {
  return DateTime.fromMillis(now, { zone: safeZone(zone) }).toFormat("yyyy-MM");
}

function ceilUtcDay(ms: number): number {
  return Math.ceil(ms / DAY_MS) * DAY_MS;
}

function floorUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function floorUtcHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function floorUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function ceilUtcMonth(ms: number): number {
  const floor = floorUtcMonth(ms);
  if (floor === ms) return ms;
  const d = new Date(floor);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** A half-open range of bucket starts, [from, to). Empty when from >= to. */
export interface BucketRange {
  from: number;
  to: number;
}

/**
 * Which bucket starts to read from each tier for [start, end) at time `now`.
 *
 * The rollup pass (history/rollups.ts) prunes hourly rows older than
 * `now - hourlyDays` and stops recomputing a daily row once that horizon has
 * passed its day, which by then holds all of its hours. So from the first UTC
 * midnight after the horizon on, every hourly row still exists, and every
 * daily row before it is complete. The same holds one tier up for monthly rows
 * at the first UTC month boundary after `now - dailyDays`. The three ranges
 * never overlap, so nothing is counted twice.
 */
export function tierRanges(
  start: number,
  end: number,
  now: number,
  retention: RetentionConfig,
): { hour: BucketRange; day: BucketRange; month: BucketRange } {
  const hourCut = ceilUtcDay(now - retention.hourlyDays * DAY_MS);
  const dayCut = ceilUtcMonth(now - retention.dailyDays * DAY_MS);
  return {
    hour: { from: Math.max(floorUtcHour(start), hourCut), to: end },
    day: { from: Math.max(floorUtcDay(start), dayCut), to: Math.min(end, hourCut) },
    month: { from: floorUtcMonth(start), to: Math.min(end, dayCut) },
  };
}

/**
 * One grouped summaries row from {@link reportStatements}: either the sum of
 * a monitor's buckets that lie wholly inside the month, or one bucket that
 * straddles its start or end. `lo`/`hi` span the bucket(s) it covers.
 */
export interface ReportGroupRow {
  monitor_id: string;
  lo: number;
  hi: number;
  checks: number;
  ok_checks: number;
  fail_checks: number;
  sum_latency_ms: number;
  monitored_seconds: number;
  down_seconds: number;
}

export interface MonitorTotals {
  checks: number;
  okChecks: number;
  failChecks: number;
  sumLatencyMs: number;
  monitoredSeconds: number;
  downSeconds: number;
}

const emptyTotals = (): MonitorTotals => ({
  checks: 0,
  okChecks: 0,
  failChecks: 0,
  sumLatencyMs: 0,
  monitoredSeconds: 0,
  downSeconds: 0,
});

/**
 * The share of a row's span [lo, hi) that lies inside [start, end): 1 for a
 * group of wholly contained buckets, a fraction for a straddling bucket.
 */
export function overlapWeight(lo: number, hi: number, start: number, end: number): number {
  if (hi <= lo) return 0;
  const overlap = Math.min(hi, end) - Math.max(lo, start);
  return overlap <= 0 ? 0 : Math.min(1, overlap / (hi - lo));
}

/** Sum the grouped rows per monitor, weighting straddling buckets by overlap. */
export function reduceReportGroups(
  rows: readonly ReportGroupRow[],
  start: number,
  end: number,
): Map<string, MonitorTotals> {
  const out = new Map<string, MonitorTotals>();
  for (const r of rows) {
    const w = overlapWeight(r.lo, r.hi, start, end);
    if (w === 0) continue;
    const t = out.get(r.monitor_id) ?? emptyTotals();
    t.checks += r.checks * w;
    t.okChecks += r.ok_checks * w;
    t.failChecks += r.fail_checks * w;
    t.sumLatencyMs += r.sum_latency_ms * w;
    t.monitoredSeconds += r.monitored_seconds * w;
    t.downSeconds += r.down_seconds * w;
    out.set(r.monitor_id, t);
  }
  return out;
}

/** The figures a report shows for one monitor, or for all of them. */
export interface ReportFigures {
  /** ok checks / checks, to 3 decimals; null when nothing was checked. */
  uptimePct: number | null;
  checks: number;
  failedChecks: number;
  /** Time spent down while being monitored, to 1 decimal. */
  downtimeMinutes: number;
  /** Time covered by checks (off-hours excluded), whole minutes. */
  monitoredMinutes: number;
  incidents: number;
  /** Mean response time of the successful checks; null when none succeeded. */
  avgResponseMs: number | null;
}

/** Turn summed totals into rounded report figures. */
export function reportFigures(t: MonitorTotals, incidents: number): ReportFigures {
  const checks = Math.round(t.checks);
  return {
    uptimePct: t.checks > 0 ? Math.round((t.okChecks / t.checks) * 100_000) / 1000 : null,
    checks,
    failedChecks: Math.round(t.failChecks),
    downtimeMinutes: Math.round((t.downSeconds / 60) * 10) / 10,
    monitoredMinutes: Math.round(t.monitoredSeconds / 60),
    incidents,
    avgResponseMs: t.okChecks > 0 ? Math.round(t.sumLatencyMs / t.okChecks) : null,
  };
}

export interface ReportMonitor extends ReportFigures {
  id: string;
  name: string;
  type: string;
}

export interface MonthlyReport {
  month: string;
  timezone: string;
  /** The month's first instant (epoch ms). */
  from: number;
  /** The next month's first instant (epoch ms, exclusive). */
  to: number;
  /** True while the month is still running: the figures cover it so far. */
  partial: boolean;
  generatedAt: number;
  monitors: ReportMonitor[];
  totals: ReportFigures;
}

interface MonitorRow {
  id: string;
  name: string;
  type: string;
}

/**
 * The three queries a report needs, as statements so a caller can send them
 * in one D1 batch: monitors that existed during the month, the grouped
 * summaries, and incidents started in the month per monitor.
 */
export function reportStatements(
  env: Env,
  bounds: MonthBounds,
  now: number,
  retention: RetentionConfig,
): D1PreparedStatement[] {
  const { hour, day, month } = tierRanges(bounds.start, bounds.end, now, retention);
  const cols = "checks, ok_checks, fail_checks, sum_latency_ms, monitored_seconds, down_seconds";
  const tier = (period: string, hiExpr: string, from: number, to: number) =>
    `SELECT monitor_id, bucket_start AS blo, ${hiExpr} AS bhi, ${cols}
       FROM summaries
      WHERE monitor_id IN (SELECT id FROM monitors) AND period = '${period}'
        AND bucket_start >= ${Math.trunc(from)} AND bucket_start < ${Math.trunc(to)}`;
  // Every value interpolated above is a number computed here, never input.
  const summariesSql = `
    WITH b AS (
      ${tier("hour", `bucket_start + ${HOUR_MS}`, hour.from, hour.to)}
      UNION ALL
      ${tier("day", `bucket_start + ${DAY_MS}`, day.from, day.to)}
      UNION ALL
      ${tier(
        "month",
        "CAST(strftime('%s', bucket_start / 1000, 'unixepoch', '+1 month') AS INTEGER) * 1000",
        month.from,
        month.to,
      )}
    )
    SELECT monitor_id, MIN(blo) AS lo, MAX(bhi) AS hi,
           SUM(checks) AS checks, SUM(ok_checks) AS ok_checks, SUM(fail_checks) AS fail_checks,
           SUM(sum_latency_ms) AS sum_latency_ms, SUM(monitored_seconds) AS monitored_seconds,
           SUM(down_seconds) AS down_seconds
      FROM b
     GROUP BY monitor_id, CASE WHEN blo >= ?1 AND bhi <= ?2 THEN 0 ELSE blo END`;
  return [
    env.DB.prepare(
      "SELECT id, name, type FROM monitors WHERE created_at < ? ORDER BY sort_order, created_at",
    ).bind(bounds.end),
    env.DB.prepare(summariesSql).bind(bounds.start, bounds.end),
    env.DB.prepare(
      `SELECT monitor_id, COUNT(*) AS n FROM incidents
        WHERE started_at >= ? AND started_at < ? GROUP BY monitor_id`,
    ).bind(bounds.start, bounds.end),
  ];
}

/** Build the report from the results of {@link reportStatements}, in order. */
export function reportFromResults(
  bounds: MonthBounds,
  now: number,
  results: readonly D1Result[],
): MonthlyReport {
  const monitors = (results[0]?.results ?? []) as MonitorRow[];
  const groups = (results[1]?.results ?? []) as ReportGroupRow[];
  const incidentRows = (results[2]?.results ?? []) as { monitor_id: string; n: number }[];
  const totalsById = reduceReportGroups(groups, bounds.start, bounds.end);
  const incidentsById = new Map(incidentRows.map((r) => [r.monitor_id, r.n]));

  const all = emptyTotals();
  let allIncidents = 0;
  const rows: ReportMonitor[] = monitors.map((m) => {
    const t = totalsById.get(m.id) ?? emptyTotals();
    const incidents = incidentsById.get(m.id) ?? 0;
    for (const k of Object.keys(all) as (keyof MonitorTotals)[]) all[k] += t[k];
    allIncidents += incidents;
    return { id: m.id, name: m.name, type: m.type, ...reportFigures(t, incidents) };
  });

  return {
    month: bounds.month,
    timezone: bounds.timezone,
    from: bounds.start,
    to: bounds.end,
    partial: bounds.end > now,
    generatedAt: now,
    monitors: rows,
    totals: reportFigures(all, allIncidents),
  };
}

/** Build one month's report: three queries in one D1 round trip. */
export async function buildMonthlyReport(
  env: Env,
  month: string,
  zone: string,
  retention: RetentionConfig,
  now: number = Date.now(),
): Promise<MonthlyReport> {
  const bounds = monthBounds(month, zone);
  const results = await env.DB.batch(reportStatements(env, bounds, now, retention));
  return reportFromResults(bounds, now, results);
}

const CSV_HEADER = [
  "month",
  "timezone",
  "monitor_id",
  "monitor",
  "type",
  "uptime_pct",
  "checks",
  "failed_checks",
  "downtime_minutes",
  "monitored_minutes",
  "incidents",
  "avg_response_ms",
];

/** The report as CSV (RFC 4180, CRLF), one row per monitor plus an "All monitors" row. */
export function reportToCsv(report: MonthlyReport): string {
  const line = (id: string, name: string, type: string, f: ReportFigures) =>
    [
      report.month,
      report.timezone,
      id,
      name,
      type,
      f.uptimePct,
      f.checks,
      f.failedChecks,
      f.downtimeMinutes,
      f.monitoredMinutes,
      f.incidents,
      f.avgResponseMs,
    ]
      .map(csvCell)
      .join(",");
  return [
    CSV_HEADER.join(","),
    ...report.monitors.map((m) => line(m.id, m.name, m.type, m)),
    line("", "All monitors", "", report.totals),
  ].join("\r\n") + "\r\n";
}
