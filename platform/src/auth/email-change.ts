/**
 * Changing an account's sign-in email. The new address gets a 6-digit code
 * and a link (like an email sign-in, ./email-sign-in.ts), and the account
 * switches only when one of them comes back to the signed-in account that
 * asked, within 15 minutes; the old address is told. Only hashes are kept.
 *
 * Starting a change needs a fresh sign-in (./fresh.ts), so a stolen,
 * long-open session can't take the account by moving its email.
 */

import { randomToken, sha256hex } from "../../../src/worker/lib/ids";
import { timingSafeEqual } from "../../../src/worker/lib/timing";
import { CODE_MAX_ATTEMPTS, EMAIL_SIGN_IN_TTL_MS, newCode } from "./email-sign-in";

export const EMAIL_CHANGE_TTL_MS = EMAIL_SIGN_IN_TTL_MS;
const ID = /^emc_[A-Za-z0-9_-]{22}$/;
const codeHash = (id: string, code: string) => sha256hex(`${id}:${code}`);

export interface StartedEmailChange {
  changeId: string;
  token: string;
  code: string;
}

/** A new pending change for the account; any older one stops working. */
export async function startEmailChange(db: D1Database, input: { accountId: string; newEmail: string; now: number }): Promise<StartedEmailChange> {
  const changeId = `emc_${randomToken(16)}`;
  const token = randomToken(32);
  const code = newCode();
  await db.batch([
    db.prepare("DELETE FROM email_changes WHERE account_id = ?").bind(input.accountId),
    db
      .prepare("INSERT INTO email_changes (id, account_id, new_email, token_hash, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(changeId, input.accountId, input.newEmail, await sha256hex(token), await codeHash(changeId, code), input.now, input.now + EMAIL_CHANGE_TTL_MS),
  ]);
  return { changeId, token, code };
}

/** The pending change behind a link, for the confirm page; null when gone or someone else's. */
export async function emailChangeByToken(db: D1Database, accountId: string, token: string, now: number): Promise<{ id: string; newEmail: string } | null> {
  if (!token || token.length > 128) return null;
  const row = await db
    .prepare("SELECT id, new_email FROM email_changes WHERE token_hash = ? AND account_id = ? AND expires_at > ?")
    .bind(await sha256hex(token), accountId, now)
    .first<{ id: string; new_email: string }>();
  return row ? { id: row.id, newEmail: row.new_email } : null;
}

/** The address a pending change is for (the code page shows it). */
export async function pendingEmailChange(db: D1Database, accountId: string, changeId: string, now: number): Promise<string | null> {
  if (!ID.test(changeId)) return null;
  const row = await db
    .prepare("SELECT new_email FROM email_changes WHERE id = ? AND account_id = ? AND expires_at > ?")
    .bind(changeId, accountId, now)
    .first<{ new_email: string }>();
  return row?.new_email ?? null;
}

export type EmailChangeCheck =
  | { ok: true; newEmail: string }
  | { ok: false; reason: "wrong_code"; remaining: number; newEmail: string }
  | { ok: false; reason: "expired" };

/** Uses the link: single use, only by the account that asked. */
export async function consumeEmailChangeLink(db: D1Database, accountId: string, token: string, now: number): Promise<EmailChangeCheck> {
  if (!token || token.length > 128) return { ok: false, reason: "expired" };
  const row = await db
    .prepare("DELETE FROM email_changes WHERE token_hash = ? AND account_id = ? RETURNING new_email, expires_at")
    .bind(await sha256hex(token), accountId)
    .first<{ new_email: string; expires_at: number }>();
  return row && row.expires_at > now ? { ok: true, newEmail: row.new_email } : { ok: false, reason: "expired" };
}

/** Checks a code: each try counted first, 5 at most, then the change is spent. */
export async function checkEmailChangeCode(db: D1Database, accountId: string, changeId: string, code: string, now: number): Promise<EmailChangeCheck> {
  const clean = code.replace(/\s+/g, "");
  if (!ID.test(changeId)) return { ok: false, reason: "expired" };
  const row = await db
    .prepare(
      `UPDATE email_changes SET attempts = attempts + 1 WHERE id = ? AND account_id = ? AND attempts < ? AND expires_at > ?
       RETURNING new_email, code_hash, attempts`,
    )
    .bind(changeId, accountId, CODE_MAX_ATTEMPTS, now)
    .first<{ new_email: string; code_hash: string; attempts: number }>();
  if (!row) return { ok: false, reason: "expired" };
  if (!(/^\d{6}$/.test(clean) && (await timingSafeEqual(await codeHash(changeId, clean), row.code_hash)))) {
    return { ok: false, reason: "wrong_code", remaining: CODE_MAX_ATTEMPTS - row.attempts, newEmail: row.new_email };
  }
  const used = await db.prepare("DELETE FROM email_changes WHERE id = ? RETURNING id").bind(changeId).first();
  return used ? { ok: true, newEmail: row.new_email } : { ok: false, reason: "expired" };
}

/**
 * Switches the account to its verified new address: the account row and its
 * email identity together, the other browsers' sessions and any sign-ins in
 * flight for either address ended. Answers false when the address was taken
 * meanwhile (another account signed up with it), and changes nothing then.
 */
export async function applyEmailChange(
  db: D1Database,
  input: { accountId: string; oldEmail: string; newEmail: string; keepSessionHash: string; now: number },
): Promise<boolean> {
  try {
    await db.batch([
      db.prepare("UPDATE accounts SET email = ?, updated_at = ? WHERE id = ? AND email = ?").bind(input.newEmail, input.now, input.accountId, input.oldEmail),
      db.prepare("UPDATE account_identities SET subject = ? WHERE account_id = ? AND kind = 'email'").bind(input.newEmail, input.accountId),
      db.prepare("DELETE FROM email_changes WHERE account_id = ?").bind(input.accountId),
      db.prepare("DELETE FROM email_logins WHERE email IN (?, ?)").bind(input.oldEmail, input.newEmail),
      db.prepare("DELETE FROM platform_sessions WHERE account_id = ? AND token_hash <> ?").bind(input.accountId, input.keepSessionHash),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) return false;
    throw error;
  }
  return true;
}

/** Spent and expired changes, for the cron's cleanup. */
export function emailChangeCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM email_changes WHERE expires_at <= ?").bind(now);
}
