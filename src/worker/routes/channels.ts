import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
  recordChannelResult,
} from "../db/channels";
import { deliverToChannel } from "../notifications/dispatcher";
import { buildTestPayload } from "../notifications/payload";
import { getSetting } from "../db/settings";

/**
 * Notification channel CRUD API mounted at /api/channels (PRD §16 Integrations).
 * All routes require an authenticated session; the auth middleware also enforces
 * CSRF on mutations. This module is config-only — sending lives in the dispatcher
 * module, and POST /:id/test is added later by the dispatcher integration.
 *
 * TODO(phase-6): redact secret config fields (discord url, webhook secret) in
 * responses — for now we return the full config so editing works.
 */
export const channels = new Hono<AppEnv>();

channels.use("*", requireAuth);

const channelCreateSchema = z.object({
  type: z.enum(["email", "discord", "webhook"]),
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()),
  events: z.array(z.string()).optional(),
});

const channelUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.string()).optional(),
});

channels.get("/", async (c) => {
  const list = await listChannels(c.env);
  return c.json({ channels: list });
});

channels.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = channelCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const channel = await createChannel(c.env, parsed.data);
  return c.json({ channel }, 201);
});

channels.get("/:id", async (c) => {
  const channel = await getChannel(c.env, c.req.param("id"));
  if (!channel) return c.json({ error: "not_found" }, 404);
  return c.json({ channel });
});

channels.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = channelUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const existing = await getChannel(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const channel = await updateChannel(c.env, id, parsed.data);
  if (!channel) return c.json({ error: "not_found" }, 404);
  return c.json({ channel });
});

channels.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getChannel(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteChannel(c.env, id);
  return c.json({ ok: true });
});

/** Send a test notification immediately and report the delivery result. */
channels.post("/:id/test", async (c) => {
  const channel = await getChannel(c.env, c.req.param("id"));
  if (!channel) return c.json({ error: "not_found" }, 404);
  const appUrl = (await getSetting(c.env, "app_url")) ?? undefined;
  const payload = buildTestPayload(channel.name ?? channel.type, appUrl);
  const result = await deliverToChannel(c.env, channel, payload);
  await recordChannelResult(c.env, channel.id, result.ok, result.error ?? null);
  return c.json(result, result.ok ? 200 : 502);
});
