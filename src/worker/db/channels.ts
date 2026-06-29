import type { Env } from "../types";
import { newId } from "../lib/ids";

/**
 * Notification channel CRUD data layer. The `notification_channels` table stores
 * config/events as JSON TEXT and `enabled` as a 0/1 integer; this module maps
 * rows to/from a camelCase `ChannelRecord` with parsed objects. Timestamps are
 * epoch milliseconds. Sending logic lives elsewhere (the dispatcher module);
 * this layer only persists configuration and last-result bookkeeping.
 *
 * TODO(phase-6): encrypt secret config fields (discord url, webhook secret) at rest.
 */

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

export async function listChannels(env: Env): Promise<ChannelRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM notification_channels ORDER BY created_at",
  ).all<ChannelRow>();
  return (res.results ?? []).map(rowToChannel);
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
  return row ? rowToChannel(row) : null;
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
      JSON.stringify(input.config),
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
    sets.push("config = ?");
    values.push(JSON.stringify(input.config));
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
