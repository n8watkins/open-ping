import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  getMaintenanceWindow,
  listMaintenanceWindows,
  updateMaintenanceWindow,
} from "../db/maintenance";

/**
 * Maintenance-window CRUD API mounted at /api/maintenance (PRD §16 Maintenance).
 * All routes require an authenticated session; the auth middleware also enforces
 * CSRF on mutations. Activity evaluation / incident suppression lives in the
 * data layer (db/maintenance) and is consumed by the scheduler.
 */
export const maintenance = new Hono<AppEnv>();

maintenance.use("*", requireAuth);

const recurrenceSchema = z.object({
  type: z.literal("weekly"),
  weekday: z.number().int().min(0).max(6),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().positive(),
});

const maintenanceCreateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  scope: z.enum(["global", "monitors"]),
  monitorIds: z.array(z.string()).optional(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  recurrence: recurrenceSchema.nullable().optional(),
  publicMessage: z.string().max(2000).optional(),
  privateNotes: z.string().max(2000).optional(),
});

const maintenanceUpdateSchema = z.object({
  title: z.string().min(1).max(200).nullable().optional(),
  scope: z.enum(["global", "monitors"]).optional(),
  monitorIds: z.array(z.string()).nullable().optional(),
  startsAt: z.number().int().optional(),
  endsAt: z.number().int().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  publicMessage: z.string().max(2000).nullable().optional(),
  privateNotes: z.string().max(2000).nullable().optional(),
});

maintenance.get("/", async (c) => {
  const list = await listMaintenanceWindows(c.env);
  return c.json({ windows: list });
});

maintenance.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = maintenanceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const window = await createMaintenanceWindow(c.env, parsed.data);
  return c.json({ window }, 201);
});

maintenance.get("/:id", async (c) => {
  const window = await getMaintenanceWindow(c.env, c.req.param("id"));
  if (!window) return c.json({ error: "not_found" }, 404);
  return c.json({ window });
});

maintenance.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = maintenanceUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const existing = await getMaintenanceWindow(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const window = await updateMaintenanceWindow(c.env, id, parsed.data);
  if (!window) return c.json({ error: "not_found" }, 404);
  return c.json({ window });
});

maintenance.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getMaintenanceWindow(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteMaintenanceWindow(c.env, id);
  return c.json({ ok: true });
});
