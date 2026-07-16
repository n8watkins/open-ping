import type { Env } from "../types";
import { newId } from "../lib/ids";
import { decryptValue, encryptValue } from "../lib/crypto";
import { isCiphertext } from "../lib/secret-config";

/**
 * Notification outbox (PRD §12). Every notification we intend to deliver is
 * first written here as a durable, per-channel delivery record, then drained by
 * the scheduler. Each row tracks its own `status`, `attempts` and
 * `next_attempt_at`, so a flaky channel retries independently of the others and
 * is eventually parked as `dead` once it exhausts `maxAttempts`.
 *
 * Idempotency is enforced by the UNIQUE `event_key`: re-enqueuing the same key
 * (e.g. a scheduler that re-runs after a crash) is a no-op via
 * `ON CONFLICT DO NOTHING`. `payload` is encrypted when MASTER_KEY is configured,
 * while legacy plaintext JSON remains readable. All timestamps are epoch milliseconds.
 */

/** Base retry delay (30s) and ceiling (1h) for exponential backoff. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;

/** Max length of a stored `last_error` string (defensive truncation). */
const MAX_ERROR_LEN = 500;

export interface OutboxEntry {
  id: string;
  eventKey: string;
  monitorId: string | null;
  channelId: string | null;
  channelType: string;
  target: string | null;
  eventType: string;
  payload: unknown;
  payloadError: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `notification_outbox` row as returned by D1. */
interface OutboxRow {
  id: string;
  event_key: string;
  monitor_id: string | null;
  channel_id: string | null;
  channel_type: string;
  target: string | null;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface ParsedPayload {
  value: unknown;
  error: string | null;
}

/** Decrypt protected payloads, accepting legacy plaintext JSON rows. */
async function parsePayload(env: Env, raw: string): Promise<ParsedPayload> {
  let serialized = raw;
  if (isCiphertext(raw)) {
    try {
      serialized = await decryptValue(env, raw);
    } catch {
      return { value: null, error: "payload_decryption_failed" };
    }
  }
  try {
    return { value: JSON.parse(serialized), error: null };
  } catch {
    return { value: null, error: "payload_invalid_json" };
  }
}

/** Map a raw row to a typed entry, parsing the JSON payload. */
async function rowToEntry(env: Env, row: OutboxRow): Promise<OutboxEntry> {
  // Upgrade a legacy plaintext payload as soon as the dispatcher claims it.
  // The current delivery still parses the original JSON below, while retained
  // sent/dead history is no longer left exposed in D1.
  if (env.MASTER_KEY && !isCiphertext(row.payload)) {
    const protectedPayload = await encryptValue(env, row.payload);
    await env.DB.prepare(
      "UPDATE notification_outbox SET payload = ?, updated_at = ? WHERE id = ? AND payload = ?",
    )
      .bind(protectedPayload, Date.now(), row.id, row.payload)
      .run();
  }
  const parsedPayload = await parsePayload(env, row.payload);
  return {
    id: row.id,
    eventKey: row.event_key,
    monitorId: row.monitor_id ?? null,
    channelId: row.channel_id ?? null,
    channelType: row.channel_type,
    target: row.target ?? null,
    eventType: row.event_type,
    payload: parsedPayload.value,
    payloadError: parsedPayload.error,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Enqueue one or more delivery records. Each is inserted `pending` with zero
 * attempts and `next_attempt_at = now`, so the next drain picks it up
 * immediately. Inserts are idempotent on `event_key`: a duplicate key is
 * silently dropped, making re-enqueue safe to retry.
 */
export async function enqueue(
  env: Env,
  entries: Array<{
    eventKey: string;
    monitorId?: string | null;
    channelId?: string | null;
    channelType: string;
    target?: string | null;
    eventType: string;
    payload: unknown;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  const protectedEntries = await Promise.all(
    entries.map(async (entry) => {
      const serialized = JSON.stringify(entry.payload) ?? "null";
      return {
        entry,
        payload: env.MASTER_KEY
          ? await encryptValue(env, serialized)
          : serialized,
      };
    }),
  );
  const statements = protectedEntries.map(({ entry: e, payload }) =>
    env.DB.prepare(
      `INSERT INTO notification_outbox (
         id, event_key, monitor_id, channel_id, channel_type, target, event_type,
         payload, status, attempts, next_attempt_at, last_error,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`,
    ).bind(
      newId("out"),
      e.eventKey,
      e.monitorId ?? null,
      e.channelId ?? null,
      e.channelType,
      e.target ?? null,
      e.eventType,
      payload,
      now,
      now,
      now,
    ),
  );
  await env.DB.batch(statements);
}

/**
 * Claim up to `limit` records that are due for delivery: those `pending` (never
 * tried) or `failed` (awaiting retry) whose `next_attempt_at` has arrived.
 * Oldest-due first so retries don't starve. Note this reads but does not lock —
 * single-drain serialization is the caller's concern (the scheduler lock).
 */
export async function claimDue(
  env: Env,
  now: number,
  limit: number,
): Promise<OutboxEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notification_outbox
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
      ORDER BY next_attempt_at
      LIMIT ?`,
  )
    .bind(now, limit)
    .all<OutboxRow>();
  return Promise.all((results ?? []).map((row) => rowToEntry(env, row)));
}

/** Mark a record as successfully delivered. */
export async function markSent(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE notification_outbox SET status = 'sent', updated_at = ? WHERE id = ?",
  )
    .bind(Date.now(), id)
    .run();
}

/**
 * Record a failed delivery attempt. `newAttemptCount` is the post-increment
 * count of attempts. `computeRetry` decides whether to schedule another retry
 * (`failed` with a backoff `next_attempt_at`) or park the record (`dead`) once
 * `maxAttempts` is reached. The error is truncated before being stored.
 */
export async function markFailed(
  env: Env,
  id: string,
  newAttemptCount: number,
  error: string,
  maxAttempts: number,
): Promise<void> {
  const now = Date.now();
  const { status, nextAttemptAt } = computeRetry(newAttemptCount, maxAttempts, now);
  // Never resurrect a terminal row: if post-send bookkeeping throws after an
  // entry is already 'sent' (or 'dead'), the caller's catch must not be able to
  // flip it back to 'failed' and cause a duplicate delivery on the next claim.
  await env.DB.prepare(
    `UPDATE notification_outbox
        SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
            updated_at = ?
      WHERE id = ? AND status NOT IN ('sent', 'dead')`,
  )
    .bind(
      status,
      newAttemptCount,
      nextAttemptAt,
      error.slice(0, MAX_ERROR_LEN),
      now,
      id,
    )
    .run();
}

/**
 * Pure exponential backoff: `min(CAP, BASE * 2^attempt)`, jitter-free. `attempt`
 * is 0-based, so attempt 0 returns BASE (30s) and the delay doubles each step up
 * to the 1h ceiling.
 */
export function backoffMs(attempt: number): number {
  const exp = 2 ** Math.max(0, attempt);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * exp);
}

/**
 * Pure retry decision. Once `newAttemptCount` reaches `maxAttempts` the record
 * is `dead` (no further retries, `nextAttemptAt = now`); otherwise it is
 * `failed` and scheduled `backoffMs(newAttemptCount)` into the future.
 */
export function computeRetry(
  newAttemptCount: number,
  maxAttempts: number,
  now: number,
): { status: "failed" | "dead"; nextAttemptAt: number } {
  if (newAttemptCount >= maxAttempts) {
    return { status: "dead", nextAttemptAt: now };
  }
  return { status: "failed", nextAttemptAt: now + backoffMs(newAttemptCount) };
}
