import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { NOTIFY_EVENTS } from "../../shared/notifications";
import { requireAuth } from "../middleware/auth";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
  recordChannelResult,
  redactChannelConfig,
  type ChannelRecord,
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
 * Secret config fields (Discord and generic webhook URLs, plus the generic
 * webhook secret) are blanked in every response via `redactChannel`; the editor
 * resubmits the blanked value and the data layer merges the stored secret back
 * in (see db/channels.ts).
 */
export const channels = new Hono<AppEnv>();

channels.use("*", requireAuth);

/** Strip secret config fields from a channel before returning it to the client. */
function redactChannel(ch: ChannelRecord): ChannelRecord {
  return { ...ch, config: redactChannelConfig(ch.type, ch.config) };
}

// --- Per-channel-type config validation (PRD §16) ---------------------------
// `config` is freeform JSON persisted verbatim and replayed on every delivery,
// so validate the load-bearing fields per channel type. Webhook/Discord URLs are
// also SSRF-guarded per-delivery (assertSafeUrl); this rejects malformed config
// up front. Unknown keys pass through so a stored field is never silently dropped.

const MAX_URL = 2048;
const MAX_SECRET = 1024;
const MAX_EMAIL = 320; // RFC 5321 forward/reverse path length

/** A length-bounded https URL (Discord + webhook endpoints are always https). */
const httpsUrl = z
  .string()
  .max(MAX_URL)
  .url()
  .refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

const emailAddr = z.string().max(MAX_EMAIL).email();
const optionalSecret = z.string().max(MAX_SECRET).optional();

/** Known notification events; bounds the optional per-channel override list. */
const eventsSchema = z.array(z.enum(NOTIFY_EVENTS)).max(NOTIFY_EVENTS.length);

const nameField = z.string().min(1).max(120).optional();

// Create: the full config is always supplied (no redacted secrets yet), so each
// type's required fields must be present and well-formed.
const channelCreateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("discord"),
    name: nameField,
    enabled: z.boolean().optional(),
    config: z.object({ url: httpsUrl }).passthrough(),
    events: eventsSchema.optional(),
  }),
  z.object({
    type: z.literal("webhook"),
    name: nameField,
    enabled: z.boolean().optional(),
    config: z.object({ url: httpsUrl, secret: optionalSecret }).passthrough(),
    events: eventsSchema.optional(),
  }),
  z.object({
    type: z.literal("email"),
    name: nameField,
    enabled: z.boolean().optional(),
    config: z
      .object({ to: emailAddr, from: emailAddr.optional() })
      .passthrough(),
    events: eventsSchema.optional(),
  }),
]);

// Update: `type` is not in the body (it comes from the stored record) and secret
// config fields arrive blanked ("") to be merged back by the data layer — so the
// Discord and generic webhook URLs may legitimately be empty here. The config
// is validated against the channel's actual type in the handler
// (updateConfigSchemas).
const channelUpdateSchema = z.object({
  name: nameField,
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  events: eventsSchema.optional(),
});

/** Allow a blanked secret ("") OR a valid https URL (redact-then-resubmit flow). */
const secretUrl = z.union([z.literal(""), httpsUrl]);

/** Per-type config validators for UPDATE (secret fields may be blank). */
const updateConfigSchemas: Record<string, z.ZodTypeAny> = {
  discord: z.object({ url: secretUrl }).passthrough(),
  webhook: z.object({ url: secretUrl, secret: optionalSecret }).passthrough(),
  email: z.object({ to: emailAddr, from: emailAddr.optional() }).passthrough(),
};

channels.get("/", async (c) => {
  const list = await listChannels(c.env);
  return c.json({ channels: list.map(redactChannel) });
});

channels.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = channelCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const channel = await createChannel(c.env, parsed.data);
  return c.json({ channel: redactChannel(channel) }, 201);
});

channels.get("/:id", async (c) => {
  const channel = await getChannel(c.env, c.req.param("id"));
  if (!channel) return c.json({ error: "not_found" }, 404);
  return c.json({ channel: redactChannel(channel) });
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

  // The update body carries no `type`, so validate the config against the
  // channel's actual stored type. Secret fields may be blank here (redacted then
  // resubmitted); the data layer merges the stored secret back in afterwards.
  if (parsed.data.config !== undefined) {
    const configSchema = updateConfigSchemas[existing.type];
    if (configSchema) {
      const cfg = configSchema.safeParse(parsed.data.config);
      if (!cfg.success) {
        return c.json({ error: "validation", issues: cfg.error.issues }, 400);
      }
    }
  }

  const channel = await updateChannel(c.env, id, parsed.data);
  if (!channel) return c.json({ error: "not_found" }, 404);
  return c.json({ channel: redactChannel(channel) });
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
