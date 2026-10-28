import type { Env } from "../types";
import { newId, randomToken } from "../lib/ids";
import { getSetting } from "./settings";
import type { VerifiedRegistration } from "../lib/webauthn";

/** A row in the `passkeys` table (migration 0015). */
export interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: string;
  alg: number;
  sign_count: number;
  transports: string | null;
  aaguid: string | null;
  backup_eligible: number;
  backup_state: number;
  rp_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** What the API returns about a passkey: never the key itself (not secret, just not needed). */
export interface PasskeySummary {
  id: string;
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** True when the passkey can sync between devices (a password manager or platform keychain). */
  synced: boolean;
}

export function summarize(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    rpId: row.rp_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    synced: row.backup_eligible === 1,
  };
}

export function parseTransports(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function listPasskeys(env: Env): Promise<PasskeyRow[]> {
  const res = await env.DB.prepare("SELECT * FROM passkeys ORDER BY created_at ASC").all<PasskeyRow>();
  return res.results ?? [];
}

export async function countPasskeys(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getPasskeyByCredentialId(env: Env, credentialId: string): Promise<PasskeyRow | null> {
  return env.DB.prepare("SELECT * FROM passkeys WHERE credential_id = ?").bind(credentialId).first<PasskeyRow>();
}

export async function getPasskey(env: Env, id: string): Promise<PasskeyRow | null> {
  return env.DB.prepare("SELECT * FROM passkeys WHERE id = ?").bind(id).first<PasskeyRow>();
}

/** Store a verified registration. Returns null when the credential is already registered. */
export async function insertPasskey(
  env: Env,
  reg: VerifiedRegistration,
  meta: { name: string; rpId: string; transports: string[] },
): Promise<PasskeyRow | null> {
  const row: PasskeyRow = {
    id: newId("pk"),
    credential_id: reg.credentialId,
    public_key: reg.publicKey,
    alg: reg.alg,
    sign_count: reg.signCount,
    transports: JSON.stringify(meta.transports),
    aaguid: reg.aaguid,
    backup_eligible: reg.backupEligible ? 1 : 0,
    backup_state: reg.backupState ? 1 : 0,
    rp_id: meta.rpId,
    name: meta.name,
    created_at: Date.now(),
    last_used_at: null,
  };
  const res = await env.DB.prepare(
    `INSERT INTO passkeys
       (id, credential_id, public_key, alg, sign_count, transports, aaguid,
        backup_eligible, backup_state, rp_id, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(credential_id) DO NOTHING`,
  )
    .bind(
      row.id,
      row.credential_id,
      row.public_key,
      row.alg,
      row.sign_count,
      row.transports,
      row.aaguid,
      row.backup_eligible,
      row.backup_state,
      row.rp_id,
      row.name,
      row.created_at,
    )
    .run();
  return res.meta.changes === 1 ? row : null;
}

/**
 * Record a successful sign-in. The counter write is a compare-and-swap on the
 * stored value, so two concurrent assertions with the same counter can't both
 * win; returns false when another request got there first.
 */
export async function recordPasskeyUse(
  env: Env,
  row: PasskeyRow,
  signCount: number,
  backupState: boolean,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE passkeys SET sign_count = ?, backup_state = ?, last_used_at = ?
      WHERE id = ? AND sign_count = ?`,
  )
    .bind(signCount, backupState ? 1 : 0, Date.now(), row.id, row.sign_count)
    .run();
  return res.meta.changes === 1;
}

/** Remove a passkey and end every session that was signed in with it. */
export async function deletePasskey(env: Env, id: string): Promise<boolean> {
  const [del] = await env.DB.batch([
    env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE identity_kind = 'passkey' AND identity = ?").bind(id),
  ]);
  return (del?.meta.changes ?? 0) === 1;
}

const USER_HANDLE_KEY = "passkey_user_handle";

/**
 * The WebAuthn user handle for this install's one administrator: 32 random
 * bytes (base64url), created with the first passkey. Every passkey shares it,
 * so a password manager files them under one account, and an assertion's
 * handle must match it.
 */
export async function getUserHandle(env: Env): Promise<string | null> {
  return getSetting(env, USER_HANDLE_KEY);
}

export async function getOrCreateUserHandle(env: Env): Promise<string> {
  const existing = await getUserHandle(env);
  if (existing) return existing;
  const handle = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(USER_HANDLE_KEY, handle, Date.now())
    .run();
  // Another request may have created it first; whichever row is stored wins.
  return (await getUserHandle(env)) ?? handle;
}
