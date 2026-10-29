import type { Env } from "../types";
import { newId, sha256hex } from "../lib/ids";
import { decryptValue, encryptValue, isCiphertext } from "../lib/crypto";

/**
 * Web Push subscription data layer (PRD §12.1 PWA device management). The
 * `push_subscriptions` table stores one row per browser/device endpoint, with
 * the VAPID encryption keys (p256dh/auth) and last-result bookkeeping. Timestamps
 * are epoch milliseconds; `disabled`/booleans are stored as 0/1 integers. Sending
 * logic lives elsewhere (the push-delivery module); this layer only persists the
 * subscription registry and delivery outcomes.
 */

/** A browser's Web Push subscription, or the Android app's FCM token (migration 0026). */
export type PushKind = "webpush" | "fcm";

export interface PushSubscriptionRecord {
  id: string;
  kind: PushKind;
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
  /** Absent only on rows read before migration 0026 ran. */
  kind?: string | null;
  endpoint: string;
  endpoint_hash: string | null;
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

let encryptionDisabledWarned = false;

/**
 * Protect browser capability credentials before persistence. Keeping the
 * no-key behavior preserves compatibility for installations that intentionally
 * run without MASTER_KEY, but the warning makes that security tradeoff visible.
 */
export async function protectPushSecrets(
  env: Env,
  values: Pick<PushSubscriptionRecord, "endpoint" | "p256dh" | "auth">,
): Promise<Pick<PushSubscriptionRecord, "endpoint" | "p256dh" | "auth">> {
  if (!env.MASTER_KEY) {
    if (!encryptionDisabledWarned) {
      encryptionDisabledWarned = true;
      console.warn(
        "[openping] MASTER_KEY is not configured: Web Push subscription " +
          "credentials are being stored in plaintext in D1.",
      );
    }
    return values;
  }
  return {
    // These values arrive from the browser, so always treat them as plaintext.
    // Prefix sniffing here would let crafted input masquerade as ciphertext and
    // make every subsequent subscription-list read fail decryption.
    endpoint: await encryptValue(env, values.endpoint),
    p256dh: await encryptValue(env, values.p256dh),
    auth: await encryptValue(env, values.auth),
  };
}

async function revealPushSecret(env: Env, value: string): Promise<string> {
  return isCiphertext(value) ? decryptValue(env, value) : value;
}

/** Map and decrypt a raw row, while accepting rows written before migration 0008. */
export async function rowToSubscription(
  env: Env,
  row: PushSubscriptionRow,
): Promise<PushSubscriptionRecord> {
  return {
    id: row.id,
    kind: row.kind === "fcm" ? "fcm" : "webpush",
    endpoint: await revealPushSecret(env, row.endpoint),
    p256dh: await revealPushSecret(env, row.p256dh),
    auth: await revealPushSecret(env, row.auth),
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
 * repeat subscribe from the same device refreshes the keys/metadata, clears the
 * `disabled` flag, and resets the failure bookkeeping (failures/last_failure_at)
 * so a device returning with fresh keys starts clean - rather than creating a
 * duplicate row.
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
  const endpointHash = await sha256hex(input.endpoint);
  const protectedValues = await protectPushSecrets(env, input);

  // Migration 0008 cannot hash legacy endpoints in SQL. Claim a matching
  // plaintext row on its next registration, then encrypt it in place.
  const legacy = await env.DB.prepare(
    `SELECT * FROM push_subscriptions
     WHERE endpoint_hash = ? OR (endpoint_hash IS NULL AND endpoint = ?)
     LIMIT 1`,
  )
    .bind(endpointHash, input.endpoint)
    .first<PushSubscriptionRow>();

  if (legacy) {
    await env.DB.prepare(
      `UPDATE push_subscriptions SET
         endpoint = ?, endpoint_hash = ?, p256dh = ?, auth = ?, label = ?,
         user_agent = ?, platform = ?, disabled = 0, failures = 0,
         last_failure_at = NULL
       WHERE id = ?`,
    )
      .bind(
        protectedValues.endpoint,
        endpointHash,
        protectedValues.p256dh,
        protectedValues.auth,
        input.label ?? null,
        input.userAgent ?? null,
        input.platform ?? null,
        legacy.id,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO push_subscriptions (
         id, endpoint, endpoint_hash, p256dh, auth, label, user_agent, platform,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        protectedValues.endpoint,
        endpointHash,
        protectedValues.p256dh,
        protectedValues.auth,
        input.label ?? null,
        input.userAgent ?? null,
        input.platform ?? null,
        now,
      )
      .run();

    // A concurrent registration can win the unique endpoint-hash insert. An
    // unconditional refresh makes the operation an upsert without depending on
    // which unique constraint SQLite checks first in plaintext compatibility
    // mode.
    await env.DB.prepare(
      `UPDATE push_subscriptions SET
         endpoint = ?, p256dh = ?, auth = ?, label = ?, user_agent = ?,
         platform = ?, disabled = 0, failures = 0, last_failure_at = NULL
       WHERE endpoint_hash = ?`,
    )
      .bind(
        protectedValues.endpoint,
        protectedValues.p256dh,
        protectedValues.auth,
        input.label ?? null,
        input.userAgent ?? null,
        input.platform ?? null,
        endpointHash,
      )
      .run();
  }

  const row = await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE endpoint_hash = ?",
  )
    .bind(endpointHash)
    .first<PushSubscriptionRow>();
  if (!row) {
    throw new Error("upsertSubscription: failed to read back upserted row");
  }
  return rowToSubscription(env, row);
}

export async function listSubscriptions(
  env: Env,
): Promise<PushSubscriptionRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM push_subscriptions ORDER BY created_at",
  ).all<PushSubscriptionRow>();
  return Promise.all(
    (res.results ?? []).map((row) => rowToSubscription(env, row)),
  );
}

/** A device as the admin UI shows it: metadata only, never the push secrets. */
export type PushDeviceSummary = Omit<PushSubscriptionRecord, "endpoint" | "p256dh" | "auth">;

/**
 * Every device, without decrypting anything, so the list (and removing a
 * device) still works when a subscription can't be decrypted, for example
 * after the MASTER_KEY was lost.
 */
export async function listDevices(env: Env): Promise<PushDeviceSummary[]> {
  const res = await env.DB.prepare(
    `SELECT id, kind, label, user_agent, platform, created_at, last_success_at,
            last_failure_at, failures, disabled
       FROM push_subscriptions ORDER BY created_at`,
  ).all<Omit<PushSubscriptionRow, "endpoint" | "endpoint_hash" | "p256dh" | "auth">>();
  return (res.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind === "fcm" ? ("fcm" as const) : ("webpush" as const),
    label: row.label,
    userAgent: row.user_agent,
    platform: row.platform,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at ?? null,
    lastFailureAt: row.last_failure_at ?? null,
    failures: row.failures ?? 0,
    disabled: row.disabled !== 0,
  }));
}

/** Which kinds of device this install can send to right now. */
export interface PushSenders {
  /** VAPID keys exist. */
  webpush: boolean;
  /** FCM_SERVICE_ACCOUNT is set (notifications/push/fcm.ts). */
  fcm: boolean;
}

/**
 * Ids of the devices eligible for delivery (not disabled, and of a kind this
 * install can send to). Enqueueing needs only the id; the dispatcher decrypts
 * one subscription when it sends, so an unreadable device can't stop an
 * incident's other notifications.
 */
export async function listActiveSubscriptionIds(env: Env, senders: PushSenders): Promise<string[]> {
  const res = await activeSubscriptionIdsStatement(env).all<{ id: string; kind: string | null }>();
  return sendableIds(res.results ?? [], senders);
}

/** The listActiveSubscriptionIds query, for a caller that batches its reads (rows: `{ id, kind }`). */
export function activeSubscriptionIdsStatement(env: Env): D1PreparedStatement {
  return env.DB.prepare("SELECT id, kind FROM push_subscriptions WHERE disabled = 0 ORDER BY created_at");
}

/** The ids among `rows` (activeSubscriptionIdsStatement's) that `senders` can reach. */
export function sendableIds(rows: Array<{ id: string; kind?: string | null }>, senders: PushSenders): string[] {
  return rows
    .filter((row) => (row.kind === "fcm" ? senders.fcm : senders.webpush))
    .map((row) => row.id);
}

/**
 * Register (or refresh) the Android app on one phone by its FCM token
 * (POST /api/push/fcm). Keyed by the token's hash, like a Web Push endpoint;
 * a phone whose token changed registers again and the old row is pruned
 * when FCM reports it gone.
 */
export async function upsertFcmDevice(
  env: Env,
  input: { token: string; label?: string; userAgent?: string },
): Promise<PushSubscriptionRecord> {
  const endpointHash = await sha256hex(`fcm:${input.token}`);
  const sealed = await protectPushSecrets(env, { endpoint: input.token, p256dh: "", auth: "" });
  // A re-registration refreshes the row; INSERT OR IGNORE covers two at once
  // (the endpoint and its hash are both unique).
  const updated = await env.DB.prepare(
    `UPDATE push_subscriptions SET label = ?, user_agent = ?, disabled = 0, failures = 0, last_failure_at = NULL
      WHERE endpoint_hash = ?`,
  )
    .bind(input.label ?? null, input.userAgent ?? null, endpointHash)
    .run();
  if (!updated.meta.changes) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO push_subscriptions (
         id, kind, endpoint, endpoint_hash, p256dh, auth, label, user_agent, platform, created_at
       ) VALUES (?, 'fcm', ?, ?, ?, ?, ?, ?, 'android', ?)`,
    )
      .bind(
        newId("psub"),
        sealed.endpoint,
        endpointHash,
        sealed.p256dh,
        sealed.auth,
        input.label ?? null,
        input.userAgent ?? null,
        Date.now(),
      )
      .run();
  }
  const row = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE endpoint_hash = ?")
    .bind(endpointHash)
    .first<PushSubscriptionRow>();
  if (!row) throw new Error("upsertFcmDevice: failed to read back the device");
  return rowToSubscription(env, row);
}

export async function subscriptionExists(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM push_subscriptions WHERE id = ?")
    .bind(id)
    .first<{ found: number }>();
  return row != null;
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
  return row ? rowToSubscription(env, row) : null;
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
