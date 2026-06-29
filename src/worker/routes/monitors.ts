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
  return c.json({ monitors: list });
});

monitors.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const monitor = await createMonitor(c.env, parsed.data);
  return c.json({ monitor }, 201);
});

monitors.get("/:id", async (c) => {
  const monitor = await getMonitor(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor });
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
  return c.json({ monitor });
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
  return c.json({ monitor });
});

monitors.post("/:id/resume", async (c) => {
  const monitor = await setPaused(c.env, c.req.param("id"), false);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor });
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
