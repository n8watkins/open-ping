import type { Env } from "../types";
import { newId } from "../lib/ids";

/**
 * Web Push subscription data layer (PRD §12.1 PWA device management). The
 * `push_subscriptions` table stores one row per browser/device endpoint, with
 * the VAPID encryption keys (p256dh/auth) and last-result bookkeeping. Timestamps
 * are epoch milliseconds; `disabled`/booleans are stored as 0/1 integers. Sending
 * logic lives elsewhere (the push-delivery module); this layer only persists the
 * subscription registry and delivery outcomes.
 */

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  userAgent: string | null;
  platform: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failures: number;
  disabled: boolean;
}

/** Raw shape of a `push_subscriptions` row as returned by D1. */
interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  user_agent: string | null;
  platform: string | null;
  created_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  failures: number;
  disabled: number;
}

/** Map a raw row to a typed record, coercing 0/1 to booleans. */
function rowToSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    label: row.label,
    userAgent: row.user_agent,
    platform: row.platform,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at ?? null,
    lastFailureAt: row.last_failure_at ?? null,
    failures: row.failures ?? 0,
    disabled: row.disabled !== 0,
  };
}

/**
 * Register (or re-register) a subscription, keyed by its unique endpoint. A
 * repeat subscribe from the same device refreshes the keys/metadata and clears
 * the `disabled` flag rather than creating a duplicate row.
 */
export async function upsertSubscription(
  env: Env,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label?: string;
    userAgent?: string;
    platform?: string;
  },
): Promise<PushSubscriptionRecord> {
  const id = newId("psub");
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (
       id, endpoint, p256dh, auth, label, user_agent, platform, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       label = excluded.label,
       user_agent = excluded.user_agent,
       platform = excluded.platform,
       disabled = 0`,
  )
    .bind(
      id,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.label ?? null,
      input.userAgent ?? null,
      input.platform ?? null,
      now,
    )
    .run();

  const row = await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE endpoint = ?",
  )
    .bind(input.endpoint)
    .first<PushSubscriptionRow>();
  if (!row) {
    throw new Error("upsertSubscription: failed to read back upserted row");
  }
  return rowToSubscription(row);
}

export async function listSubscriptions(
  env: Env,
): Promise<PushSubscriptionRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM push_subscriptions ORDER BY created_at",
  ).all<PushSubscriptionRow>();
  return (res.results ?? []).map(rowToSubscription);
}

/** Subscriptions eligible for delivery (not disabled). */
export async function listActiveSubscriptions(
  env: Env,
): Promise<PushSubscriptionRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE disabled = 0 ORDER BY created_at",
  ).all<PushSubscriptionRow>();
  return (res.results ?? []).map(rowToSubscription);
}

export async function getSubscription(
  env: Env,
  id: string,
): Promise<PushSubscriptionRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE id = ?",
  )
    .bind(id)
    .first<PushSubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

export async function deleteSubscription(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
    .bind(id)
    .run();
}

export async function setDisabled(
  env: Env,
  id: string,
  disabled: boolean,
): Promise<void> {
  await env.DB.prepare("UPDATE push_subscriptions SET disabled = ? WHERE id = ?")
    .bind(disabled ? 1 : 0, id)
    .run();
}

/**
 * Record the outcome of a push delivery attempt. On success, stamp
 * last_success_at and reset the failure counter. When the push service reports
 * the subscription as gone (404/410), the row is removed automatically (PRD:
 * expired subscriptions are pruned). Otherwise stamp last_failure_at and bump
 * the failure counter.
 */
export async function recordPushResult(
  env: Env,
  id: string,
  ok: boolean,
  opts?: { expired?: boolean },
): Promise<void> {
  if (opts?.expired) {
    await deleteSubscription(env, id);
    return;
  }
  const now = Date.now();
  if (ok) {
    await env.DB.prepare(
      "UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?",
    )
      .bind(now, id)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE push_subscriptions SET last_failure_at = ?, failures = failures + 1 WHERE id = ?",
    )
      .bind(now, id)
      .run();
  }
}
