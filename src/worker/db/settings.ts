import type { Env } from "../types";
import { decryptValue, encryptValue } from "../lib/crypto";
import { IN_JSON_LIST, jsonList } from "./sql-list";

/**
 * Settings store: a key/value table in D1 for app configuration. Values may be
 * stored as plaintext or AES-GCM encrypted (for secrets that must live in D1
 * rather than as Worker secrets). Encryption is transparent to callers via the
 * `secret` option.
 */

export interface SettingRow {
  value: string | null;
  encrypted: number;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value, encrypted FROM settings WHERE key = ?",
  )
    .bind(key)
    .first<SettingRow>();
  if (!row || row.value == null) return null;
  return row.encrypted ? decryptValue(env, row.value) : row.value;
}

/** Several settings in one query (for a caller that batches its reads). */
export function settingsStatement(env: Env, keys: readonly string[]): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT key, value, encrypted FROM settings WHERE key ${IN_JSON_LIST}`,
  ).bind(jsonList(keys));
}

/**
 * Decode the rows of {@link settingsStatement}: every requested key is present,
 * null when it is unset, exactly as getSetting would return it.
 */
export async function settingsFromRows(
  env: Env,
  keys: readonly string[],
  rows: (SettingRow & { key: string })[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(keys.map((k) => [k, null]));
  for (const row of rows) {
    if (row.value == null) continue;
    out.set(row.key, row.encrypted ? await decryptValue(env, row.value) : row.value);
  }
  return out;
}

/** Parse a JSON setting value; null when unset or not valid JSON (as getJSON). */
export function parseJSONSetting<T>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Store a value as given (`encrypted` says whether it is already ciphertext),
 * as a statement a caller can put in a batch.
 */
export function setSettingStatement(
  env: Env,
  key: string,
  stored: string,
  encrypted = false,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value, encrypted, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       encrypted = excluded.encrypted,
       updated_at = excluded.updated_at`,
  ).bind(key, stored, encrypted ? 1 : 0, Date.now());
}

export async function setSetting(
  env: Env,
  key: string,
  value: string,
  opts: { secret?: boolean } = {},
): Promise<void> {
  const secret = opts.secret ?? false;
  const stored = secret ? await encryptValue(env, value) : value;
  await setSettingStatement(env, key, stored, secret).run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  return parseJSONSetting<T>(await getSetting(env, key));
}

export async function setJSON<T>(
  env: Env,
  key: string,
  value: T,
  opts: { secret?: boolean } = {},
): Promise<void> {
  await setSetting(env, key, JSON.stringify(value), opts);
}

/**
 * True for a settings key that names a secret and must never be returned to a
 * client or written into a backup. The `encrypted` column alone is NOT a safe
 * filter: best-effort mode (no MASTER_KEY) stores secrets - notably the VAPID
 * private key - with encrypted=0/plaintext. This name-based denylist guarantees
 * every consumer (export, GET /api/settings, PUT response) is protected.
 */
export function isSecretSettingKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("vapid") ||
    lower.includes("secret") ||
    lower.includes("key") ||
    lower.includes("token") ||
    lower.includes("password")
  );
}

/** Non-secret settings only - safe for export/backup (PRD §23 excludes secrets). */
export async function getExportableSettings(
  env: Env,
): Promise<Record<string, string>> {
  const res = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE encrypted = 0",
  ).all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) {
    // Defense in depth: skip secret-named keys even when stored at encrypted=0
    // (e.g. the VAPID private key generated in best-effort mode).
    if (isSecretSettingKey(r.key)) continue;
    out[r.key] = r.value;
  }
  return out;
}
