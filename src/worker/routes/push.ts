import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  upsertSubscription,
  listSubscriptions,
  getSubscription,
  deleteSubscription,
  setDisabled,
  recordPushResult,
} from "../db/push";
import { getSetting } from "../db/settings";
import { getVapid, ensureVapidPublicKey } from "../notifications/push/vapid";
import { sendWebPush } from "../notifications/push/webpush";

/**
 * Web Push device-management API mounted at /api/push (PRD §12.1 PWA device
 * management). All routes require an authenticated session; the auth middleware
 * also enforces CSRF on mutations. This module is registry-only — sending lives
 * in the push-delivery module, and POST /devices/:id/test is wired later by the
 * push-delivery integration.
 */
export const push = new Hono<AppEnv>();

push.use("*", requireAuth);

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  label: z.string().optional(),
});

/** Public VAPID key the client needs to create a PushSubscription. */
push.get("/vapid-public-key", async (c) => {
  const publicKey =
    c.env.VAPID_PUBLIC_KEY ??
    (await getSetting(c.env, "vapid_public_key")) ??
    null;
  return c.json({ publicKey });
});

push.post("/subscribe", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const subscription = await upsertSubscription(c.env, {
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    label: parsed.data.label,
    userAgent: c.req.header("user-agent") ?? undefined,
  });
  return c.json({ subscription }, 201);
});

push.get("/devices", async (c) => {
  const devices = await listSubscriptions(c.env);
  return c.json({ devices });
});

push.delete("/devices/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getSubscription(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteSubscription(c.env, id);
  return c.json({ ok: true });
});

push.post("/devices/:id/disable", async (c) => {
  const id = c.req.param("id");
  const existing = await getSubscription(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await setDisabled(c.env, id, true);
  return c.json({ ok: true });
});

push.post("/devices/:id/enable", async (c) => {
  const id = c.req.param("id");
  const existing = await getSubscription(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await setDisabled(c.env, id, false);
  return c.json({ ok: true });
});

/** Generate + persist a VAPID keypair if none exists; return the public key. */
push.post("/generate-vapid", async (c) => {
  const publicKey = await ensureVapidPublicKey(c.env);
  return c.json({ publicKey });
});

/** Send a test push to one device and report the result. */
push.post("/devices/:id/test", async (c) => {
  const sub = await getSubscription(c.env, c.req.param("id"));
  if (!sub) return c.json({ error: "not_found" }, 404);
  const vapid = await getVapid(c.env);
  if (!vapid) return c.json({ error: "vapid_not_configured" }, 400);
  const appUrl = (await getSetting(c.env, "app_url")) ?? undefined;
  const result = await sendWebPush({
    subscription: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    payload: JSON.stringify({
      title: "✅ OpenPing test",
      body: "Push notifications are working.",
      url: appUrl,
    }),
    vapid,
  });
  await recordPushResult(c.env, sub.id, result.ok, { expired: result.expired });
  return c.json(result, result.ok ? 200 : 502);
});
