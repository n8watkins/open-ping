import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  upsertSubscription,
  listDevices,
  subscriptionExists,
  getSubscription,
  deleteSubscription,
  setDisabled,
  recordPushResult,
  registerFcmDevice,
  deleteFcmDevice,
  MAX_FCM_DEVICES,
} from "../db/push";
import { fcmProjectId, isFcmToken, sendFcm, serviceAccount } from "../notifications/push/fcm";
import { fcmAlert } from "../notifications/dispatcher";
import { configuredOrigin } from "../lib/app-origin";
import { getSetting } from "../db/settings";
import { getVapid, ensureVapidPublicKey } from "../notifications/push/vapid";
import { sendWebPush } from "../notifications/push/webpush";

/**
 * Web Push device-management API mounted at /api/push (PRD §12.1 PWA device
 * management). All routes require an authenticated session; the auth middleware
 * also enforces CSRF on mutations. This module is registry-only - sending lives
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

/**
 * The OpenPing Android app's notifications (docs/ANDROID.md): whether this
 * install can send them (FCM_SERVICE_ACCOUNT is set), and through which
 * Firebase project. The app's token only works with that project.
 */
push.get("/fcm", (c) => {
  const projectId = fcmProjectId(c.env);
  return c.json({ available: projectId !== null, projectId });
});

const fcmSchema = z.object({
  token: z.string().refine(isFcmToken, "Not an FCM registration token"),
  /** The Firebase project the app's build belongs to. */
  projectId: z.string().min(1).max(100),
  /** The phone, for the device list: "Pixel 8". */
  label: z.string().max(80).optional(),
  /** The app's quiet refresh on start: never adds a phone or turns one back on. */
  refresh: z.boolean().optional(),
  /** The token the app sent before, when Firebase has changed it since. */
  previousToken: z.string().refine(isFcmToken).optional(),
});

/** Register the Android app on this phone: its FCM token, revocable like any push device. */
push.post("/fcm", async (c) => {
  const projectId = fcmProjectId(c.env);
  if (!projectId) return c.json({ error: "fcm_not_configured" }, 404);
  const parsed = fcmSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  // A token from another Firebase project would only ever fail to send.
  if (parsed.data.projectId !== projectId) return c.json({ error: "fcm_project_mismatch", projectId }, 409);
  const result = await registerFcmDevice(c.env, {
    token: parsed.data.token,
    previousToken: parsed.data.previousToken,
    label: parsed.data.label ? `OpenPing app on ${parsed.data.label}` : "OpenPing app",
    userAgent: c.req.header("user-agent") ?? undefined,
    refresh: parsed.data.refresh === true,
  });
  if (!result.ok) {
    // Removed under Push devices: the app forgets it was registered here.
    if (result.error === "fcm_device_removed") return c.json({ error: result.error }, 404);
    return c.json({ error: result.error, limit: MAX_FCM_DEVICES }, 409);
  }
  const { endpoint: _token, p256dh: _p, auth: _a, ...summary } = result.device;
  return c.json({ device: summary }, parsed.data.refresh ? 200 : 201);
});

/** The app forgets this install (it was removed in the app): forget this phone's notifications. */
push.delete("/fcm", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  if (!isFcmToken(body.token)) return c.json({ error: "validation" }, 400);
  return (await deleteFcmDevice(c.env, body.token)) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

push.get("/devices", async (c) => {
  const devices = await listDevices(c.env);
  return c.json({ devices });
});

push.delete("/devices/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await subscriptionExists(c.env, id))) return c.json({ error: "not_found" }, 404);
  await deleteSubscription(c.env, id);
  return c.json({ ok: true });
});

push.post("/devices/:id/disable", async (c) => {
  const id = c.req.param("id");
  if (!(await subscriptionExists(c.env, id))) return c.json({ error: "not_found" }, 404);
  await setDisabled(c.env, id, true);
  return c.json({ ok: true });
});

push.post("/devices/:id/enable", async (c) => {
  const id = c.req.param("id");
  if (!(await subscriptionExists(c.env, id))) return c.json({ error: "not_found" }, 404);
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
  if (sub.kind === "fcm") {
    const sa = serviceAccount(c.env);
    if (!sa) return c.json({ error: "fcm_not_configured" }, 400);
    const origin = (await configuredOrigin(c.env)) ?? new URL(c.req.url).origin;
    const result = await sendFcm(
      sa,
      sub.endpoint,
      fcmAlert(origin, {
        event: "test",
        monitorId: "test",
        monitorName: "OpenPing",
        state: "up",
        title: "✅ OpenPing test",
        body: "Notifications from this OpenPing reach the app.",
        url: `${origin}/`,
        detectedAt: Date.now(),
      }),
    );
    await recordPushResult(c.env, sub.id, result.ok, { expired: result.expired || result.invalid });
    return c.json({ ok: result.ok, error: result.error }, result.ok ? 200 : 502);
  }
  const vapid = await getVapid(c.env);
  if (!vapid) return c.json({ error: "vapid_not_configured" }, 400);
  const appUrl = c.env.APP_URL ?? (await getSetting(c.env, "app_url")) ?? undefined;
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
