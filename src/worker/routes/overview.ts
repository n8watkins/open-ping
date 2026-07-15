import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { listMonitors } from "../db/monitors";
import { listChannels } from "../db/channels";
import { listCategories } from "../db/categories";
import type { MonitorState } from "../../shared/states";
import type { MonitorRecord } from "../db/monitors";
import type {
  DnsConfig,
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
    case "heartbeat":
      return null;
  }
}

overview.get("/", async (c) => {
  const now = Date.now();
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
  ] = await Promise.all([
    listMonitors(c.env),
    listCategories(c.env),
    listChannels(c.env),
    c.env.DB.prepare(
      `SELECT monitor_id, state, state_since, last_checked_at, last_duration_ms,
              last_status_code, next_check_at, active_incident_id
       FROM monitor_state`,
    ).all<StateRow>(),
    c.env.DB.prepare(
      `SELECT monitor_id, SUM(checks) AS checks, SUM(ok_checks) AS ok_checks
       FROM summaries
       WHERE period = 'hour' AND bucket_start >= ? AND bucket_start <= ?
       GROUP BY monitor_id`,
    )
      .bind(since, now)
      .all<SummaryCountRow>(),
    c.env.DB.prepare(
      `SELECT monitor_id, at, ok, state
       FROM (
         SELECT monitor_id, at, ok, state,
                ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY at DESC) AS row_num
         FROM samples
         WHERE at >= ? AND at <= ?
       )
       WHERE row_num <= 28
       ORDER BY monitor_id, at`,
    )
      .bind(since, now)
      .all<RecentCheckRow>(),
    c.env.DB.prepare(
      `SELECT started_at FROM incidents
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at`,
    )
      .bind(since, now)
      .all<IncidentStartRow>(),
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_incidents,
         MAX(CASE WHEN status = 'resolved' THEN resolved_at END) AS latest_resolved_at
       FROM incidents`,
    ).first<IncidentAggregateRow>(),
    c.env.DB.prepare(
      `SELECT id, cron, started_at AS startedAt, finished_at AS finishedAt, ok,
              monitors_checked AS monitorsChecked, check_failures AS checkFailures,
              notification_failures AS notificationFailures, duration_ms AS durationMs
       FROM scheduler_runs ORDER BY started_at DESC LIMIT 1`,
    ).first(),
  ]);

  // Resolve category names in one query: id -> name for the badge on each row.
  const categoryNames = new Map<string, string>(
    categories.map((cat) => [cat.id, cat.name]),
  );
  const states = new Map<string, StateRow>(
    (stateRes.results ?? []).map((s) => [s.monitor_id, s]),
  );
  const summaryRows = summaryRes.results ?? [];
  const uptimeByMonitor = new Map(
    summaryRows.map((row) => [
      row.monitor_id,
      computeOverallUptime([row]),
    ]),
  );
  const recentChecksByMonitor = groupRecentChecks(sampleRes.results ?? []);

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
    unknown: 0,
  };

  const summaries = monitors.map((m) => {
    const st = states.get(m.id);
    const state: MonitorState = m.paused ? "paused" : (st?.state ?? "unknown");
    counts[state] = (counts[state] ?? 0) + 1;
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      target: monitorTarget(m),
      state,
      paused: m.paused,
      intervalSeconds: m.intervalSeconds,
      scheduleMode: m.schedule.mode,
      lastCheckedAt: st?.last_checked_at ?? null,
      lastDurationMs: st?.last_duration_ms ?? null,
      lastStatusCode: st?.last_status_code ?? null,
      nextCheckAt: st?.next_check_at ?? null,
      stateSince: st?.state_since ?? null,
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
    overallUptime24h: computeOverallUptime(summaryRows),
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

  return c.json({
    counts: { ...counts, openIncidents },
    monitors: summaries,
    analytics,
    channels,
    lastRun,
  });
});
