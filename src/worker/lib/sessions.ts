import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env, SessionRow } from "../types";
import { randomToken, sha256hex } from "./ids";
import type { LabeledStatement } from "./batch";

/**
 * Session management (PRD §13): secure HTTP-only cookies, SameSite protection,
 * rotation on login, server-side per-session CSRF secret, explicit logout.
 *
 * The cookie holds a random token; only its SHA-256 hash is persisted as the
 * session id, so a DB leak can't be replayed as a valid cookie.
 */

export const SESSION_COOKIE = "op_session";
export const CSRF_HEADER = "x-csrf-token";

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const TOUCH_INTERVAL_MS = 1000 * 60 * 5; // throttle last_seen writes

type Ctx = Context<AppEnv>;

/** Create a fresh session (also used for rotation) and set the cookie. */
export async function createSession(
  c: Ctx,
  identity: string,
  identityKind: SessionRow["identity_kind"],
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ id: string; csrf: string; expiresAt: number }> {
  const token = randomToken(32);
  const id = await sha256hex(token);
  const csrf = randomToken(24);
  const now = Date.now();
  const expiresAt = now + ttlMs;

  await c.env.DB.prepare(
    `INSERT INTO sessions
       (id, identity, identity_kind, csrf_secret, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      identity,
      identityKind,
      csrf,
      now,
      expiresAt,
      now,
      c.req.header("user-agent") ?? null,
      c.req.header("cf-connecting-ip") ?? null,
    )
    .run();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });

  return { id, csrf, expiresAt };
}

/** Resolve the current session from the cookie, or null. Expired rows are purged. */
export async function getSession(c: Ctx): Promise<SessionRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await c.env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await destroySessionById(c.env, id);
    return null;
  }
  return row;
}

/** Update last_seen_at at most every TOUCH_INTERVAL_MS to limit writes. */
export async function touchSession(env: Env, row: SessionRow): Promise<void> {
  const now = Date.now();
  if (row.last_seen_at && now - row.last_seen_at < TOUCH_INTERVAL_MS) return;
  await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(now, row.id)
    .run();
}

/**
 * End the caller's current session, if any, without touching the cookie: for
 * a sign-in that is about to set a new one (rotation).
 */
export async function endCurrentSession(c: Ctx): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySessionById(c.env, await sha256hex(token));
}

/** Destroy the caller's session and clear the cookie. */
export async function destroySession(c: Ctx): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySessionById(c.env, await sha256hex(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

async function destroySessionById(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
}

/**
 * Revoke every session ("sign out everywhere"). OpenPing has one administrator,
 * so this ends GitHub, email and passkey sessions alike. Lets the admin
 * forcibly kill a leaked/stolen cookie (otherwise valid up to 30 days) without
 * waiting for expiry. Exposed via POST /api/auth/logout-all.
 */
export async function revokeAllSessions(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions`).run();
}

/**
 * Purge expired sessions, auth_tokens (oauth_state / magic_link) and used
 * hand-off nonces (hosted mode, db/handoff-nonces.ts), as
 * statements the scheduler batches with its other end-of-run work. Auth tokens
 * are otherwise only deleted on a matching callback/verify, so abandoned flows
 * (or scripted hits to /auth/github/start) would accumulate without bound. Both
 * are index-backed (idx_sessions_expires, idx_auth_tokens_expires,
 * idx_used_handoff_nonces_expires).
 */
export function expiredAuthCleanupStatements(env: Env, now: number = Date.now()): LabeledStatement[] {
  return [
    {
      label: "expired-session cleanup",
      stmt: env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
    },
    {
      label: "expired-auth-token cleanup",
      stmt: env.DB.prepare(`DELETE FROM auth_tokens WHERE expires_at <= ?`).bind(now),
    },
    {
      label: "expired-handoff-nonce cleanup",
      stmt: env.DB.prepare(`DELETE FROM used_handoff_nonces WHERE expires_at <= ?`).bind(now),
    },
  ];
}
