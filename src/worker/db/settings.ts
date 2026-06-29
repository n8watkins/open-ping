import type { Env } from "../types";
import { decryptValue, encryptValue } from "../lib/crypto";

/**
 * Settings store: a key/value table in D1 for app configuration. Values may be
 * stored as plaintext or AES-GCM encrypted (for secrets that must live in D1
 * rather than as Worker secrets). Encryption is transparent to callers via the
 * `secret` option.
 */

interface SettingRow {
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

export async function setSetting(
  env: Env,
  key: string,
  value: string,
  opts: { secret?: boolean } = {},
): Promise<void> {
  const secret = opts.secret ?? false;
  const stored = secret ? await encryptValue(env, value) : value;
  await env.DB.prepare(
    `INSERT INTO settings (key, value, encrypted, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       encrypted = excluded.encrypted,
       updated_at = excluded.updated_at`,
  )
    .bind(key, stored, secret ? 1 : 0, Date.now())
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  const raw = await getSetting(env, key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJSON<T>(
  env: Env,
  key: string,
  value: T,
  opts: { secret?: boolean } = {},
): Promise<void> {
  await setSetting(env, key, JSON.stringify(value), opts);
}

/** Non-secret settings only — safe for export/backup (PRD §23 excludes secrets). */
export async function getExportableSettings(
  env: Env,
): Promise<Record<string, string>> {
  const res = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE encrypted = 0",
  ).all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.key] = r.value;
  return out;
}
