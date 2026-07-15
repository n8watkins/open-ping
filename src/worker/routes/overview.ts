import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { listMonitors } from "../db/monitors";
import { listChannels } from "../db/channels";
import { listCategories } from "../db/categories";
import { computeUptime } from "../history/metrics";
import type { MonitorState } from "../../shared/states";

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

const DAY = 24 * 60 * 60 * 1000;

overview.get("/", async (c) => {
  const now = Date.now();
  const monitors = await listMonitors(c.env);

  // Resolve category names in one query: id → name for the badge on each row.
  const categoryNames = new Map<string, string>(
    (await listCategories(c.env)).map((cat) => [cat.id, cat.name]),
  );

  const stateRes = await c.env.DB.prepare(
    `SELECT monitor_id, state, state_since, last_checked_at, last_duration_ms,
            last_status_code, next_check_at, active_incident_id
     FROM monitor_state`,
  ).all<StateRow>();
  const states = new Map<string, StateRow>(
    (stateRes.results ?? []).map((s) => [s.monitor_id, s]),
  );

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

  const summaries = await Promise.all(
    monitors.map(async (m) => {
      const st = states.get(m.id);
      const state: MonitorState = m.paused ? "paused" : (st?.state ?? "unknown");
      counts[state] = (counts[state] ?? 0) + 1;
      const uptime = await computeUptime(c.env, m.id, now - DAY, now);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        state,
        paused: m.paused,
        intervalSeconds: m.intervalSeconds,
        scheduleMode: m.schedule.mode,
        lastCheckedAt: st?.last_checked_at ?? null,
        lastDurationMs: st?.last_duration_ms ?? null,
        lastStatusCode: st?.last_status_code ?? null,
        nextCheckAt: st?.next_check_at ?? null,
        stateSince: st?.state_since ?? null,
        uptime24h: uptime.uptimePct,
        publicVisible: m.public?.visible ?? false,
        categoryId: m.categoryId,
        categoryName: m.categoryId ? categoryNames.get(m.categoryId) ?? null : null,
      };
    }),
  );

  const openIncidentsRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'`,
  ).first<{ n: number }>();

  const channels = (await listChannels(c.env)).map((ch) => ({
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

  const lastRun = await c.env.DB.prepare(
    `SELECT id, cron, started_at AS startedAt, finished_at AS finishedAt, ok,
            monitors_checked AS monitorsChecked, check_failures AS checkFailures,
            notification_failures AS notificationFailures, duration_ms AS durationMs
     FROM scheduler_runs ORDER BY started_at DESC LIMIT 1`,
  ).first();

  return c.json({
    counts: { ...counts, openIncidents: openIncidentsRow?.n ?? 0 },
    monitors: summaries,
    channels,
    lastRun,
  });
});
