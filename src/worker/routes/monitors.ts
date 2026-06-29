import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { createMonitorSchema } from "../../shared/schemas";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  setPaused,
  updateMonitor,
} from "../db/monitors";
import { runMonitorCheck } from "../checks/runner";
import { applyCheckResult } from "../checks/state";
import { computeUptime, computeIncidentMetrics } from "../history/metrics";
import { redactConfig } from "../lib/secret-config";
import type { MonitorRecord } from "../db/monitors";

/** Strip secret config fields before sending a monitor to the client. */
function redactMonitor(m: MonitorRecord): MonitorRecord {
  return { ...m, config: redactConfig(m.config as Record<string, unknown>) as MonitorRecord["config"] };
}

/**
 * Monitor CRUD API mounted at /api/monitors. All routes require an
 * authenticated session; the auth middleware also enforces CSRF on mutations.
 *
 * TODO(phase-6): redact secret config fields (auth password/token, heartbeat
 * secret) in responses — for now we return the full config so editing works.
 */
export const monitors = new Hono<AppEnv>();

monitors.use("*", requireAuth);

monitors.get("/", async (c) => {
  const list = await listMonitors(c.env);
  return c.json({ monitors: list.map(redactMonitor) });
});

monitors.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const monitor = await createMonitor(c.env, parsed.data);
  return c.json({ monitor: redactMonitor(monitor) }, 201);
});

monitors.get("/:id", async (c) => {
  const monitor = await getMonitor(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

/** Rich detail: monitor + current state + uptime windows + latency + incidents. */
monitors.get("/:id/detail", async (c) => {
  const id = c.req.param("id");
  const monitor = await getMonitor(c.env, id);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const DAY = 86400000;

  const state = await c.env.DB.prepare(
    `SELECT state, state_since, last_checked_at, last_success_at, last_duration_ms,
            last_status_code, last_error, consecutive_failures, consecutive_successes,
            next_check_at, active_incident_id, is_flapping
     FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(id)
    .first();

  const [d1, d7, d30, d365] = await Promise.all([
    computeUptime(c.env, id, now - DAY, now),
    computeUptime(c.env, id, now - 7 * DAY, now),
    computeUptime(c.env, id, now - 30 * DAY, now),
    computeUptime(c.env, id, now - 365 * DAY, now),
  ]);

  const latency = await c.env.DB.prepare(
    `SELECT AVG(duration_ms) AS avg, MIN(duration_ms) AS min, MAX(duration_ms) AS max
     FROM samples WHERE monitor_id = ? AND ok = 1 AND duration_ms IS NOT NULL AND at >= ?`,
  )
    .bind(id, now - DAY)
    .first<{ avg: number | null; min: number | null; max: number | null }>();

  const samplesRes = await c.env.DB.prepare(
    `SELECT at, ok, state, duration_ms AS durationMs, status_code AS statusCode, error
     FROM samples WHERE monitor_id = ? AND at >= ? ORDER BY at`,
  )
    .bind(id, now - DAY)
    .all();

  const incidentsRes = await c.env.DB.prepare(
    `SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt,
            duration_seconds AS durationSeconds, error
     FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(id)
    .all();

  const incidentMetrics = await computeIncidentMetrics(c.env, id, now);

  return c.json({
    monitor: redactMonitor(monitor),
    state,
    uptime: { d1: d1.uptimePct, d7: d7.uptimePct, d30: d30.uptimePct, d365: d365.uptimePct },
    latency: { avg: latency?.avg ?? null, min: latency?.min ?? null, max: latency?.max ?? null },
    incidentMetrics,
    recentSamples: samplesRes.results ?? [],
    recentIncidents: incidentsRes.results ?? [],
  });
});

monitors.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const existing = await getMonitor(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.type !== parsed.data.type) {
    return c.json({ error: "type_immutable" }, 400);
  }
  const monitor = await updateMonitor(c.env, id, parsed.data);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

monitors.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getMonitor(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteMonitor(c.env, id);
  return c.json({ ok: true });
});

monitors.post("/:id/pause", async (c) => {
  const monitor = await setPaused(c.env, c.req.param("id"), true);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

monitors.post("/:id/resume", async (c) => {
  const monitor = await setPaused(c.env, c.req.param("id"), false);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

/**
 * Manual test (PRD §9). Runs a check now and returns the outcome. By default it
 * does NOT affect stored history/state; pass ?apply=1 to persist the result.
 * HTTP monitors only — heartbeats are push-driven.
 */
monitors.post("/:id/test", async (c) => {
  const monitor = await getMonitor(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "not_found" }, 404);
  if (monitor.type !== "http") {
    return c.json({ error: "not_testable", message: "Heartbeat monitors are push-driven." }, 400);
  }
  const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";
  const outcome = await runMonitorCheck(monitor, { now: Date.now() });
  if (apply) await applyCheckResult(c.env, monitor, outcome);
  return c.json({ outcome, applied: apply });
});
