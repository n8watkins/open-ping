import type { Env } from "../types";
import { newId, randomToken, sha256hex } from "../lib/ids";
import type { LabeledStatement } from "../lib/batch";

/**
 * Storage for the Hosted waitlist (migration 0030). A row is pending until its
 * owner opens the confirm link, then confirmed; a pending row that is never
 * confirmed expires after PENDING_DAYS and the scheduler deletes it. Only the
 * SHA-256 of a link token is stored, a confirm link works once, and a leave link
 * deletes the row. Every write is one statement or one batch (a transaction), so
 * a double click, a replayed link or two sign-ups at once can't leave a
 * half-done row.
 */

export const PENDING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SignupState = "new" | "pending" | "confirmed";

/** Starts (or finds) the row for an address. Never changes a confirmed row. */
export async function startSignup(env: Env, email: string, now: number): Promise<{ id: string; state: SignupState }> {
  // A pending row past its expiry that isn't purged yet starts over.
  await env.DB.prepare("DELETE FROM waitlist WHERE email = ? AND confirmed_at IS NULL AND expires_at <= ?").bind(email, now).run();
  const inserted = await env.DB.prepare(
    `INSERT INTO waitlist (id, email, created_at, confirmed_at, expires_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(email) DO NOTHING RETURNING id`,
  )
    .bind(newId("wl"), email, now, now + PENDING_DAYS * DAY_MS)
    .first<{ id: string }>();
  if (inserted) return { id: inserted.id, state: "new" };
  const row = await env.DB.prepare("SELECT id, confirmed_at FROM waitlist WHERE email = ?").bind(email).first<{ id: string; confirmed_at: number | null }>();
  // Deleted between the two statements (the owner just left): treat it as gone.
  if (!row) return startSignup(env, email, now);
  return { id: row.id, state: row.confirmed_at === null ? "pending" : "confirmed" };
}

export interface SignupLinks {
  confirm: string;
  leave: string;
}

/**
 * New links for an email about to be sent. The confirm token replaces any unused
 * one and restarts the seven days; the leave token is added next to the older
 * ones, so a link in an earlier email keeps working.
 */
export async function issueLinks(env: Env, id: string, now: number): Promise<SignupLinks> {
  const links = { confirm: randomToken(24), leave: randomToken(24) };
  const expires = now + PENDING_DAYS * DAY_MS;
  const insert = "INSERT INTO waitlist_tokens (token_hash, waitlist_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist_tokens WHERE waitlist_id = ? AND purpose = 'confirm' AND used_at IS NULL").bind(id),
    env.DB.prepare("UPDATE waitlist SET expires_at = ? WHERE id = ? AND confirmed_at IS NULL").bind(expires, id),
    env.DB.prepare(insert).bind(await sha256hex(links.confirm), id, "confirm", now, expires),
    env.DB.prepare(insert).bind(await sha256hex(links.leave), id, "leave", now, null),
  ]);
  return links;
}

export type ConfirmResult = "confirmed" | "already" | "expired" | "unknown";

/**
 * Uses a confirm link. One transaction: the first statement spends the token,
 * and the second confirms only for the token that statement spent, so a replay
 * or a second click changes nothing.
 */
export async function confirmSignup(env: Env, token: string, now: number): Promise<ConfirmResult> {
  const hash = await sha256hex(token);
  const [spent] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE waitlist_tokens SET used_at = ? WHERE token_hash = ? AND purpose = 'confirm' AND used_at IS NULL AND expires_at > ?",
    ).bind(now, hash, now),
    env.DB.prepare(
      `UPDATE waitlist SET confirmed_at = ?, expires_at = NULL
       WHERE confirmed_at IS NULL AND id = (SELECT waitlist_id FROM waitlist_tokens WHERE token_hash = ? AND used_at = ?)`,
    ).bind(now, hash, now),
  ]);
  if ((spent?.meta.changes ?? 0) > 0) return "confirmed";
  const row = await env.DB.prepare(
    `SELECT t.used_at AS used_at, t.expires_at AS expires_at, w.confirmed_at AS confirmed_at
     FROM waitlist_tokens t JOIN waitlist w ON w.id = t.waitlist_id
     WHERE t.token_hash = ? AND t.purpose = 'confirm'`,
  )
    .bind(hash)
    .first<{ used_at: number | null; expires_at: number | null; confirmed_at: number | null }>();
  if (!row) return "unknown";
  if (row.confirmed_at !== null) return "already";
  return "expired";
}

/** Uses a leave link: deletes the row (its tokens go with it). False when it was already gone. */
export async function leaveWaitlist(env: Env, token: string): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "DELETE FROM waitlist WHERE id = (SELECT waitlist_id FROM waitlist_tokens WHERE token_hash = ? AND purpose = 'leave')",
  )
    .bind(await sha256hex(token))
    .run();
  return meta.changes > 0;
}

/** The daily upkeep: pending rows past their expiry, and with them their tokens. */
export function expiredWaitlistCleanupStatements(env: Env, now: number = Date.now()): LabeledStatement[] {
  return [
    {
      label: "expired-waitlist cleanup",
      stmt: env.DB.prepare("DELETE FROM waitlist WHERE confirmed_at IS NULL AND expires_at <= ?").bind(now),
    },
  ];
}

export interface WaitlistSummary {
  confirmed: number;
  pending: number;
}

/** Counts for the settings report; a pending row past its expiry doesn't count. */
export async function waitlistSummary(env: Env, now: number): Promise<WaitlistSummary> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(confirmed_at IS NOT NULL), 0) AS confirmed,
            COALESCE(SUM(confirmed_at IS NULL AND expires_at > ?), 0) AS pending
     FROM waitlist`,
  )
    .bind(now)
    .first<{ confirmed: number; pending: number }>();
  return { confirmed: row?.confirmed ?? 0, pending: row?.pending ?? 0 };
}
