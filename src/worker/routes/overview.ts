import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { listMonitors } from "../db/monitors";
import { listChannels } from "../db/channels";
import { listCategories } from "../db/categories";
import type { MonitorState } from "../../shared/states";
import type { MonitorRecord } from "../db/monitors";
import type {
  DnsConfig,
  CertConfig,
  DomainConfig,
  HttpConfig,
  TcpConfig,
} from "../../shared/schemas";
import {
  computeIncidentOverview,
  computeOverallUptime,
  groupRecentChecks,
  type RecentCheckRow,
  type SummaryCountRow,
} from "../history/overview-analytics";
import { loadRangeHistory } from "../history/range";
import { CRON_CADENCE, effectiveIntervals, type Cadence } from "../lib/cadence";
import { cadenceFor } from "../lib/monitor-intervals";
import { iconAtFor, listIconRows, refreshStaleIcons } from "../lib/favicon";
import { requestWaitUntil } from "./monitors";
import { hostedPlan } from "../lib/plan-limits";
import { bucketStart } from "../history/rollups";
import { CHECK_LOG_LENGTH_SQL, loggedChecks } from "../history/check-log";
import { parseTimeRange, type OverviewHistoryResponse } from "../../shared/time-range";
import {
  isWindowActiveAt,
  listMaintenanceWindows,
  nextRecurringOccurrence,
  type MaintenanceWindow,
} from "../db/maintenance";

/** Dashboard overview API mounted at /api/overview. */
export const overview = new Hono<AppEnv>();
overview.use("*", requireAuth);

interface StateRow {
  monitor_id: string;
  state: MonitorState;
  state_since: number | null;
  last_checked_at: number | null;
  last_duration_ms: number | null;
  last_status_code: number | null;
  next_check_at: number | null;
  active_incident_id: string | null;
}

interface IncidentAggregateRow {
  open_incidents: number;
  latest_resolved_at: number | null;
}

interface IncidentStartRow {
  started_at: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** How many of each monitor's latest checks the Overview's bar shows. */
const RECENT_CHECKS = 28;

interface HourRow {
  monitor_id: string;
  bucket_start: number;
  checks: number;
  ok_checks: number;
  /** The hour's logged checks, only for the hours the latest 28 can reach. */
  check_log: string | null;
}

/** Human-searchable target shown only to the authenticated administrator. */
export function monitorTarget(monitor: MonitorRecord): string | null {
  switch (monitor.type) {
    case "http": {
      try {
        const parsed = new URL((monitor.config as HttpConfig).url);
        // The compact list needs a searchable host/path, not credentials or
        // query tokens that could leak into screenshots and shared displays.
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return null;
      }
    }
    case "dns":
      return (monitor.config as DnsConfig).hostname;
    case "tcp":
      return `${(monitor.config as TcpConfig).host}:${(monitor.config as TcpConfig).port}`;
    case "domain":
      return (monitor.config as DomainConfig).domain;
    case "cert": {
      const c = monitor.config as CertConfig;
      return c.port === 443 ? c.host : `${c.host}:${c.port}`;
    }
    case "heartbeat":
      return null;
  }
}

overview.get("/", async (c) => {
  const now = Date.now();
  const [body, maintenance] = await Promise.all([
    buildOverview(c.env, now, cadenceFor(hostedPlan(c)), requestWaitUntil(c)),
    maintenanceOutlook(c.env, now),
  ]);
  return c.json({ ...body, maintenance });
});

/**
 * Range history for the Overview: every monitor's uptime, state and response
 * time per hour (24h, 7d) or UTC day (30d, 90d), the install-wide series, and
 * the incidents that overlap the range. `range` defaults to 7d.
 */
overview.get("/history", async (c) => {
  const range = parseTimeRange(c.req.query("range"));
  const h = await loadRangeHistory(c.env, range, Date.now());
  const body: OverviewHistoryResponse = {
    range: h.range,
    from: h.from,
    to: h.to,
    now: h.now,
    bucketMs: h.bucketMs,
    overall: h.overall,
    // The cards need only the state, uptime and response time per bucket.
    monitors: h.monitors.map(({ buckets, ...m }) => ({
      ...m,
      buckets: buckets.map(({ t, state, checks, okChecks, uptime, avgMs }) => ({
        t,
        state,
        checks,
        okChecks,
        uptime,
        avgMs,
      })),
    })),
    incidents: h.incidents,
    incidentCount: h.incidentCount,
  };
  return c.json(body);
});

const WEEK_MS = 7 * DAY;

/**
 * Start of the weekly occurrence that is running at `now` (UTC, like the rest
 * of the maintenance engine): the latest rule match at or before `now`. PURE.
 */
export function currentOccurrenceStart(
  r: NonNullable<MaintenanceWindow["recurrence"]>,
  now: number,
): number {
  const [h, m] = r.start.split(":").map(Number);
  const d = new Date(now);
  const weekStart =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * DAY;
  let start = weekStart + r.weekday * DAY + (h ?? 0) * 60 * 60_000 + (m ?? 0) * 60_000;
  if (start > now) start -= WEEK_MS;
  return start;
}

/** How far ahead the Overview looks for scheduled maintenance. */
const MAINTENANCE_HORIZON_MS = 14 * DAY;

export interface MaintenanceOutlookEntry {
  id: string;
  title: string | null;
  scope: MaintenanceWindow["scope"];
  monitorIds: string[] | null;
  startsAt: number;
  endsAt: number;
  recurring: boolean;
}

/**
 * Maintenance the administrator should know about: windows active now, and
 * the next 14 days of upcoming ones (a recurring window by its next
 * occurrence), soonest first, at most 5. Unlike the public status page, windows
 * without a public message are included. One D1 read.
 */
export async function maintenanceOutlook(
  env: Env,
  now: number,
): Promise<{ active: MaintenanceOutlookEntry[]; upcoming: MaintenanceOutlookEntry[] }> {
  const all = await listMaintenanceWindows(env);
  const entry = (w: MaintenanceWindow, startsAt: number, endsAt: number) => ({
    id: w.id,
    title: w.title,
    scope: w.scope,
    monitorIds: w.monitorIds,
    startsAt,
    endsAt,
    recurring: w.recurrence != null,
  });
  const active: MaintenanceOutlookEntry[] = [];
  const upcoming: MaintenanceOutlookEntry[] = [];
  const horizon = now + MAINTENANCE_HORIZON_MS;
  for (const w of all) {
    if (isWindowActiveAt(w, now)) {
      if (w.recurrence == null) {
        active.push(entry(w, w.startsAt, w.endsAt));
      } else {
        const startsAt = currentOccurrenceStart(w.recurrence, now);
        active.push(entry(w, startsAt, startsAt + w.recurrence.durationMinutes * 60_000));
      }
      continue;
    }
    if (w.recurrence == null) {
      if (w.startsAt > now && w.startsAt <= horizon) upcoming.push(entry(w, w.startsAt, w.endsAt));
    } else {
      const occ = nextRecurringOccurrence(w, now);
      if (occ && occ.startsAt <= horizon) upcoming.push(entry(w, occ.startsAt, occ.endsAt));
    }
  }
  upcoming.sort((a, b) => a.startsAt - b.startsAt);
  return { active, upcoming: upcoming.slice(0, 5) };
}

/**
 * The dashboard overview: every monitor's current state and 24h uptime, the
 * state counts, incident analytics, channel health and the latest scheduler
 * run. Shared by GET /api/overview and the MCP `get_status` tool, so both
 * report the same numbers. About nine D1 reads, run in parallel.
 */
/**
 * `cadence`: how this install is scheduled (lib/monitor-intervals.ts,
 * cadenceFor), for each monitor's real check interval.
 */
export async function buildOverview(
  env: Env,
  now: number = Date.now(),
  cadence: Cadence = CRON_CADENCE,
  /** When given, stale site icons are refreshed after the response (lib/favicon.ts). */
  waitUntil?: (p: Promise<unknown>) => void,
) {
  const since = now - DAY;
  const [
    monitors,
    categories,
    channelRecords,
    stateRes,
    summaryRes,
    sampleRes,
    incidentStartsRes,
    incidentAggregate,
    lastRun,
    iconRows,
  ] = await Promise.all([
    listMonitors(env),
    listCategories(env),
    listChannels(env),
    env.DB.prepare(
      `SELECT monitor_id, state, state_since, last_checked_at, last_duration_ms,
              last_status_code, next_check_at, active_incident_id
       FROM monitor_state`,
    ).all<StateRow>(),
    env.DB.prepare(
      // Each hour of the day, for the 24-hour uptime, and the passing checks
      // it logged (history/check-log.ts) for the hours the latest 28 checks
      // can reach: an hour's log comes back only while the hours after it log
      // fewer than 28, so a monitor checked every minute sends an hour or two.
      // The partial hour 24 hours back is read for its checks only.
      `SELECT monitor_id, bucket_start, checks, ok_checks,
              CASE WHEN COALESCE(SUM(logged) OVER (
                     PARTITION BY monitor_id ORDER BY bucket_start DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) < ?3
                   THEN check_log END AS check_log
         FROM (SELECT monitor_id, bucket_start, checks, ok_checks, check_log,
                      ${CHECK_LOG_LENGTH_SQL} AS logged
                 FROM summaries
                WHERE monitor_id IN (SELECT id FROM monitors)
                  AND period = 'hour' AND bucket_start >= ?1 AND bucket_start <= ?2)`,
    )
      .bind(bucketStart("hour", since), now, RECENT_CHECKS)
      .all<HourRow>(),
    env.DB.prepare(
      // Each monitor's last 28 sample rows of the day (the checks that have
      // one; the rest are logged in the hour rows above), reached through the
      // (monitor_id, at) index: the 28th newest is found first (materialized,
      // and CROSS JOIN keeps it the outer loop), so a monitor checked every
      // minute reads under 100 rows instead of its 1,440.
      `WITH cut AS MATERIALIZED (
         SELECT m.id AS monitor_id,
                COALESCE(
                  (SELECT at FROM samples WHERE monitor_id = m.id AND at >= ?1 AND at <= ?2
                    ORDER BY at DESC LIMIT 1 OFFSET 27),
                  ?1) AS from_at
           FROM monitors m
       )
       SELECT s.monitor_id, s.at, s.ok, s.state
       FROM cut
       CROSS JOIN samples s ON s.monitor_id = cut.monitor_id AND s.at >= cut.from_at AND s.at <= ?2
       ORDER BY s.monitor_id, s.at`,
    )
      .bind(since, now)
      .all<RecentCheckRow>(),
    env.DB.prepare(
      `SELECT started_at FROM incidents
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at`,
    )
      .bind(since, now)
      .all<IncidentStartRow>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_incidents,
         MAX(CASE WHEN status = 'resolved' THEN resolved_at END) AS latest_resolved_at
       FROM incidents`,
    ).first<IncidentAggregateRow>(),
    env.DB.prepare(
      `SELECT id, cron, started_at AS startedAt, finished_at AS finishedAt, ok,
              monitors_checked AS monitorsChecked, check_failures AS checkFailures,
              notification_failures AS notificationFailures, duration_ms AS durationMs
       FROM scheduler_runs ORDER BY started_at DESC LIMIT 1`,
    ).first(),
    listIconRows(env),
  ]);
  refreshStaleIcons(env, monitors, iconRows, waitUntil, now);

  // Resolve category names in one query: id -> name for the badge on each row.
  const categoryNames = new Map<string, string>(
    categories.map((cat) => [cat.id, cat.name]),
  );
  const states = new Map<string, StateRow>(
    (stateRes.results ?? []).map((s) => [s.monitor_id, s]),
  );
  const hourRows = summaryRes.results ?? [];
  const countsByMonitor = new Map<string, SummaryCountRow>();
  const recentRows: RecentCheckRow[] = [...(sampleRes.results ?? [])];
  for (const row of hourRows) {
    if (row.bucket_start >= since) {
      const c = countsByMonitor.get(row.monitor_id) ?? { monitor_id: row.monitor_id, checks: 0, ok_checks: 0 };
      c.checks += Number(row.checks) || 0;
      c.ok_checks += Number(row.ok_checks) || 0;
      countsByMonitor.set(row.monitor_id, c);
    }
    for (const check of loggedChecks([row], since, now)) {
      recentRows.push({ monitor_id: row.monitor_id, at: check.at, ok: 1, state: check.state });
    }
  }
  const uptimeByMonitor = new Map(
    [...countsByMonitor.values()].map((row) => [row.monitor_id, computeOverallUptime([row])]),
  );
  const recentChecksByMonitor = groupRecentChecks(recentRows, RECENT_CHECKS);

  const counts: Record<string, number> = {
    total: monitors.length,
    up: 0,
    degraded: 0,
    down: 0,
    suspended: 0,
    scheduled_off: 0,
    paused: 0,
    maintenance: 0,
    warming_up: 0,
    cant_check: 0,
    unknown: 0,
  };

  const intervals = effectiveIntervals(monitors, cadence);
  const summaries = monitors.map((m) => {
    const st = states.get(m.id);
    const state: MonitorState = m.paused ? "paused" : (st?.state ?? "unknown");
    counts[state] = (counts[state] ?? 0) + 1;
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      target: monitorTarget(m),
      iconAt: iconAtFor(m, iconRows.get(m.id)),
      state,
      paused: m.paused,
      intervalSeconds: m.intervalSeconds,
      effectiveIntervalSeconds: intervals.get(m.id)?.seconds ?? m.intervalSeconds,
      intervalReason: intervals.get(m.id)?.reason ?? "set",
      scheduleMode: m.schedule.mode,
      lastCheckedAt: st?.last_checked_at ?? null,
      lastDurationMs: st?.last_duration_ms ?? null,
      lastStatusCode: st?.last_status_code ?? null,
      nextCheckAt: st?.next_check_at ?? null,
      stateSince: st?.state_since ?? null,
      activeIncidentId: st?.active_incident_id ?? null,
      uptime24h: uptimeByMonitor.get(m.id) ?? 100,
      recentChecks: recentChecksByMonitor.get(m.id) ?? [],
      publicVisible: m.public?.visible ?? false,
      categoryId: m.categoryId,
      categoryName: m.categoryId ? categoryNames.get(m.categoryId) ?? null : null,
    };
  });

  const openIncidents = Number(incidentAggregate?.open_incidents) || 0;
  const incidentAnalytics = computeIncidentOverview({
    recentIncidentStarts: (incidentStartsRes.results ?? []).map(
      (row) => row.started_at,
    ),
    openIncidents,
    latestResolvedAt: incidentAggregate?.latest_resolved_at ?? null,
    earliestMonitorCreatedAt:
      monitors.length > 0
        ? Math.min(...monitors.map((monitor) => monitor.createdAt))
        : null,
    now,
  });
  const analytics = {
    overallUptime24h: computeOverallUptime([...countsByMonitor.values()]),
    ...incidentAnalytics,
  };

  const channels = channelRecords.map((ch) => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
    lastSuccessAt: ch.lastSuccessAt,
    lastFailureAt: ch.lastFailureAt,
    healthy:
      ch.lastFailureAt == null ||
      (ch.lastSuccessAt != null && ch.lastSuccessAt >= ch.lastFailureAt),
  }));

  return {
    counts: { ...counts, openIncidents },
    monitors: summaries,
    analytics,
    channels,
    lastRun,
  };
}
