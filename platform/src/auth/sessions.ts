/**
 * Platform sessions: a random token in a `__Host-` cookie on app.<domain>,
 * stored only as its SHA-256. Thirty days, like OpenPing's own sessions; a
 * disabled account's sessions stop working at once.
 */

import { randomToken, sha256hex } from "../../../src/worker/lib/ids";
import { getAccount, type Account } from "../accounts";
import { clearCookie, readCookie, setCookie } from "./cookies";

export const SESSION_COOKIE = "__Host-op_platform";
export const SESSION_TTL_MS = 30 * 86_400_000;
/** last_seen_at is written at most this often. */
const TOUCH_EVERY_MS = 3_600_000;

export type SignInMethod = "email" | "github" | "passkey";

export interface Session {
  account: Account;
  tokenHash: string;
  method: SignInMethod;
  /** When this browser signed in (epoch ms): the admin console asks for a recent passkey sign-in. */
  createdAt: number;
  /** A passkey session's credential id (account_identities.subject); null for email and GitHub. */
  passkeyCredential: string | null;
}

/** Starts a session and answers the Set-Cookie header for it. */
export async function createSession(
  db: D1Database,
  accountId: string,
  method: SignInMethod,
  now: number,
  passkeyCredential: string | null = null,
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      "INSERT INTO platform_sessions (token_hash, account_id, method, created_at, expires_at, last_seen_at, passkey_credential) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256hex(token), accountId, method, now, now + SESSION_TTL_MS, now, method === "passkey" ? passkeyCredential : null)
    .run();
  return setCookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
}

export async function readSession(db: D1Database, request: Request, now: number): Promise<Session | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256hex(token);
  const row = await db
    .prepare("SELECT account_id, method, created_at, expires_at, last_seen_at, passkey_credential FROM platform_sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ account_id: string; method: SignInMethod; created_at: number; expires_at: number; last_seen_at: number; passkey_credential: string | null }>();
  if (!row || row.expires_at <= now) return null;
  const account = await getAccount(db, row.account_id);
  if (!account || account.disabledAt !== null) return null;
  if (now - row.last_seen_at > TOUCH_EVERY_MS) {
    await db.prepare("UPDATE platform_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }
  return { account, tokenHash, method: row.method, createdAt: row.created_at, passkeyCredential: row.passkey_credential };
}

/** Ends the browser's session (if any) and answers the header that clears its cookie. */
export async function endSession(db: D1Database, request: Request): Promise<string> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token && token.length <= 128) {
    await db.prepare("DELETE FROM platform_sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
  }
  return clearCookie(SESSION_COOKIE);
}

/** Expired sessions, for the cron's cleanup. */
export function sessionCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM platform_sessions WHERE expires_at <= ?").bind(now);
}
