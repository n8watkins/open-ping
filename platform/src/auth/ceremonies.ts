/**
 * A passkey or GitHub ceremony in progress: a random value in a short-lived
 * cookie binds it to the browser that started it, and the row (keyed by the
 * cookie's hash) holds its challenge. Consumed once, by DELETE ... RETURNING.
 */

import { randomToken, sha256hex } from "../../../src/worker/lib/ids";
import { clearCookie, readCookie, setCookie } from "./cookies";

export const CEREMONY_COOKIE = "__Host-op_ceremony";
export const CEREMONY_TTL_MS = 5 * 60_000;

export type CeremonyKind = "passkey_register" | "passkey_sign_in" | "github";

export interface Ceremony {
  challenge: string;
  /** GitHub only: the PKCE code_verifier. */
  verifier: string | null;
  accountId: string | null;
  nextPath: string | null;
}

/** Starts a ceremony and answers the Set-Cookie header that binds it to this browser. */
export async function startCeremony(
  db: D1Database,
  input: { kind: CeremonyKind; challenge: string; verifier?: string; accountId: string | null; nextPath: string | null; now: number },
): Promise<string> {
  const value = randomToken(32);
  await db
    .prepare("INSERT INTO auth_ceremonies (id, kind, challenge, verifier, account_id, next_path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256hex(value), input.kind, input.challenge, input.verifier ?? null, input.accountId, input.nextPath, input.now + CEREMONY_TTL_MS)
    .run();
  return setCookie(CEREMONY_COOKIE, value, CEREMONY_TTL_MS / 1000);
}

/** Takes this browser's ceremony of `kind`, once. Null when there is none or it expired. */
export async function takeCeremony(db: D1Database, request: Request, kind: CeremonyKind, now: number): Promise<Ceremony | null> {
  const value = readCookie(request, CEREMONY_COOKIE);
  if (!value || value.length > 128) return null;
  const row = await db
    .prepare("DELETE FROM auth_ceremonies WHERE id = ? AND kind = ? RETURNING challenge, verifier, account_id, next_path, expires_at")
    .bind(await sha256hex(value), kind)
    .first<{ challenge: string; verifier: string | null; account_id: string | null; next_path: string | null; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  return { challenge: row.challenge, verifier: row.verifier, accountId: row.account_id, nextPath: row.next_path };
}

export const clearCeremonyCookie = () => clearCookie(CEREMONY_COOKIE);

export function ceremonyCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM auth_ceremonies WHERE expires_at <= ?").bind(now);
}
