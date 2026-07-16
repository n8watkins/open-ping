import type { Env } from "../types";
import { newId } from "../lib/ids";
import { encryptValue, decryptValue } from "../lib/crypto";
import { isCiphertext } from "../lib/secret-config";

/**
 * Notification channel CRUD data layer. The `notification_channels` table stores
 * config/events as JSON TEXT and `enabled` as a 0/1 integer; this module maps
 * rows to/from a camelCase `ChannelRecord` with parsed objects. Timestamps are
 * epoch milliseconds. Sending logic lives elsewhere (the dispatcher module);
 * this layer only persists configuration and last-result bookkeeping.
 *
 * Secret config fields are capability secrets (Discord and generic webhook
 * URLs, plus the generic-webhook HMAC secret) and are encrypted at rest.
 * Encryption is BEST-EFFORT, mirroring monitors: when `env.MASTER_KEY` is unset
 * the config is stored as plaintext, and `getChannel`/`listChannels` DECRYPT so
 * the dispatcher always receives the real secret. Routes redact these fields in
 * API responses (see `redactChannelConfig`) and carry stored secrets forward on
 * update (see `mergeChannelSecrets`).
 */

const CIPHERTEXT_PREFIX = "v1:";

/** Capability-secret config field names per channel type. */
const CHANNEL_SECRET_FIELDS: Record<string, readonly string[]> = {
  discord: ["url"],
  // A generic webhook destination is a capability URL just like Discord's:
  // possession is often enough to submit messages to the receiver.
  webhook: ["url", "secret"],
};

/** Secret config field names for a channel type ([] for types with no secrets). */
function secretFieldsFor(type: string): readonly string[] {
  return CHANNEL_SECRET_FIELDS[type] ?? [];
}

/**
 * Deep-clone `config`, encrypting each secret field that holds a non-empty
 * plaintext string. Idempotent (`v1:` values are left as-is). When
 * `env.MASTER_KEY` is unset the clone is returned UNCHANGED (plaintext at rest).
 */
async function encryptChannelConfig(
  env: Env,
  type: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clone = structuredClone(config);
  if (!env.MASTER_KEY) return clone;
  for (const field of secretFieldsFor(type)) {
    const value = clone[field];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !isCiphertext(value)
    ) {
      clone[field] = await encryptValue(env, value);
    }
  }
  return clone;
}

/**
 * Deep-clone `config`, decrypting each secret field whose value is a `v1:`
 * ciphertext. A failed decrypt never throws outward — the value is left as-is.
 */
async function decryptChannelConfig(
  env: Env,
  type: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clone = structuredClone(config);
  for (const field of secretFieldsFor(type)) {
    const value = clone[field];
    if (typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX)) {
      try {
        clone[field] = await decryptValue(env, value);
      } catch {
        // Leave as-is (missing/wrong key, corrupt ciphertext).
      }
    }
  }
  return clone;
}

/**
 * Deep-clone `config` with every secret field blanked to `""` so API responses
 * never expose secrets. The editor treats an empty value as "unchanged".
 */
export function redactChannelConfig(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(config);
  for (const field of secretFieldsFor(type)) {
    if (typeof clone[field] === "string") clone[field] = "";
  }
  return clone;
}

/**
 * Update-flow merge: clone of `incoming`, but for each secret field whose
 * incoming value is empty/absent while the stored value is a non-empty string,
 * carry the stored value forward (so a redacted-then-resubmitted config keeps
 * its secret).
 */
export function mergeChannelSecrets(
  type: string,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(incoming);
  for (const field of secretFieldsFor(type)) {
    const value = clone[field];
    if (typeof value !== "string" || value.length === 0) {
      const existingValue = existing[field];
      if (typeof existingValue === "string" && existingValue.length > 0) {
        clone[field] = existingValue;
      }
    }
  }
  return clone;
}

export interface ChannelRecord {
  id: string;
  type: "email" | "discord" | "webhook" | "push";
  name: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[] | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `notification_channels` row as returned by D1. */
interface ChannelRow {
  id: string;
  type: string;
  name: string | null;
  enabled: number;
  config: string;
  events: string | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Parse a JSON column, falling back to a sensible empty on null/corrupt data. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const CHANNEL_TYPES = ["email", "discord", "webhook", "push"] as const;

/** Map a raw row to a typed record, parsing JSON and coercing 0/1 to booleans. */
function rowToChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    type: (CHANNEL_TYPES as readonly string[]).includes(row.type)
      ? (row.type as ChannelRecord["type"])
      : "webhook",
    name: row.name,
    enabled: row.enabled !== 0,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    events: parseJson<string[] | null>(row.events, null),
    lastSuccessAt: row.last_success_at ?? null,
    lastFailureAt: row.last_failure_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Decrypt the secret config fields of a record in place, returning it. */
async function decryptRecord(
  env: Env,
  rec: ChannelRecord,
  storedConfig: string,
): Promise<ChannelRecord> {
  // SQL migrations cannot encrypt legacy plaintext capability values because
  // they do not have access to MASTER_KEY. Upgrade them on the next read so an
  // existing webhook does not remain plaintext indefinitely after deployment.
  const protectedConfig = await encryptChannelConfig(env, rec.type, rec.config);
  if (JSON.stringify(protectedConfig) !== JSON.stringify(rec.config)) {
    await env.DB.prepare(
      "UPDATE notification_channels SET config = ?, updated_at = ? WHERE id = ? AND config = ?",
    )
      .bind(JSON.stringify(protectedConfig), Date.now(), rec.id, storedConfig)
      .run();
  }
  rec.config = await decryptChannelConfig(env, rec.type, protectedConfig);
  return rec;
}

export async function listChannels(env: Env): Promise<ChannelRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM notification_channels ORDER BY created_at",
  ).all<ChannelRow>();
  return Promise.all(
    (res.results ?? []).map((r) =>
      decryptRecord(env, rowToChannel(r), r.config),
    ),
  );
}

export async function getChannel(
  env: Env,
  id: string,
): Promise<ChannelRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM notification_channels WHERE id = ?",
  )
    .bind(id)
    .first<ChannelRow>();
  return row ? decryptRecord(env, rowToChannel(row), row.config) : null;
}

export async function createChannel(
  env: Env,
  input: {
    type: string;
    name?: string;
    enabled?: boolean;
    config: Record<string, unknown>;
    events?: string[];
  },
): Promise<ChannelRecord> {
  const id = newId("ch");
  const now = Date.now();
  const storedConfig = await encryptChannelConfig(env, input.type, input.config);

  await env.DB.prepare(
    `INSERT INTO notification_channels (
       id, type, name, enabled, config, events, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.type,
      input.name ?? null,
      (input.enabled ?? true) ? 1 : 0,
      JSON.stringify(storedConfig),
      input.events == null ? null : JSON.stringify(input.events),
      now,
      now,
    )
    .run();

  const created = await getChannel(env, id);
  if (!created) {
    throw new Error("createChannel: failed to read back inserted row");
  }
  return created;
}

export async function updateChannel(
  env: Env,
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    events?: string[];
  },
): Promise<ChannelRecord | null> {
  const existing = await getChannel(env, id);
  if (!existing) return null;

  // Partial update: only the provided fields are written; updated_at always
  // bumps. id, type, created_at and last-result bookkeeping are preserved.
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    values.push(input.name);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }
  if (input.config !== undefined) {
    // Carry forward redacted (blanked) secrets, then encrypt at rest.
    const merged = mergeChannelSecrets(
      existing.type,
      input.config,
      existing.config,
    );
    const storedConfig = await encryptChannelConfig(env, existing.type, merged);
    sets.push("config = ?");
    values.push(JSON.stringify(storedConfig));
  }
  if (input.events !== undefined) {
    sets.push("events = ?");
    values.push(JSON.stringify(input.events));
  }
  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  await env.DB.prepare(
    `UPDATE notification_channels SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  return getChannel(env, id);
}

export async function deleteChannel(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM notification_channels WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * Record the outcome of a delivery attempt. On success, stamp last_success_at
 * and clear last_error; on failure, stamp last_failure_at and store the error.
 */
export async function recordChannelResult(
  env: Env,
  id: string,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  const now = Date.now();
  if (ok) {
    await env.DB.prepare(
      "UPDATE notification_channels SET last_success_at = ?, last_error = NULL WHERE id = ?",
    )
      .bind(now, id)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE notification_channels SET last_failure_at = ?, last_error = ? WHERE id = ?",
    )
      .bind(now, error ?? null, id)
      .run();
  }
}
