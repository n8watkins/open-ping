/**
 * Email sign-in (decision D3): one message carries a link and a 6-digit
 * code, and either finishes the sign-in, once, within 15 minutes. The link
 * suits the device that reads the mail; the code suits signing in on another
 * one (read the mail on a phone, type the code on a laptop).
 *
 * Only hashes are stored. A code allows 5 wrong tries, then that sign-in is
 * spent and a new one has to be asked for; asking for one cancels the
 * address's older sign-ins, so only the latest code is ever live. Wrong
 * codes are also capped per address per day (LIMITS.codeFailuresPerAddress
 * in the routes), after which only the link works. With a 6-digit code that
 * leaves an attacker at most 10 guesses a day at one address, about a 1 in
 * 100,000 chance, so the code stays 6 digits: easy to read off a phone and
 * type on a laptop. The link opens a page with a
 * button rather than signing in on GET, so mail scanners that fetch every
 * link can't use it up.
 */

import { randomToken, sha256hex } from "../../../src/worker/lib/ids";
import { timingSafeEqual } from "../../../src/worker/lib/timing";
import { escapeHtml } from "../ui";

export const EMAIL_SIGN_IN_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 6;

/** A uniformly random 6-digit code (leading zeros allowed). */
export function newCode(): string {
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    // 4_294_000_000 is a multiple of 10^6: rejecting above it keeps every code equally likely.
    if (value! < 4_294_000_000) return String(value! % 1_000_000).padStart(CODE_LENGTH, "0");
  }
}

const codeHash = (loginId: string, code: string) => sha256hex(`${loginId}:${code}`);

export interface StartedEmailSignIn {
  loginId: string;
  token: string;
  code: string;
}

export async function createEmailSignIn(
  db: D1Database,
  input: { email: string; nextPath: string | null; now: number },
): Promise<StartedEmailSignIn> {
  const loginId = `eml_${randomToken(16)}`;
  const token = randomToken(32);
  const code = newCode();
  await db.batch([
    // Only the latest sign-in for an address is live: older codes and links stop working.
    db.prepare("DELETE FROM email_logins WHERE email = ?").bind(input.email),
    db
      .prepare(
        `INSERT INTO email_logins (id, email, token_hash, code_hash, next_path, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(loginId, input.email, await sha256hex(token), await codeHash(loginId, code), input.nextPath, input.now, input.now + EMAIL_SIGN_IN_TTL_MS),
  ]);
  return { loginId, token, code };
}

export interface FinishedEmailSignIn {
  email: string;
  nextPath: string | null;
}

/** The address a sign-in is for, or null when it is gone. */
export async function emailOfSignIn(db: D1Database, loginId: string, now: number): Promise<string | null> {
  if (!/^eml_[A-Za-z0-9_-]{22}$/.test(loginId)) return null;
  const row = await db.prepare("SELECT email FROM email_logins WHERE id = ? AND expires_at > ?").bind(loginId, now).first<{ email: string }>();
  return row?.email ?? null;
}

/** A login id that matches no sign-in, for the page shown when nothing was sent. */
export const decoyLoginId = () => `eml_${randomToken(16)}`;

/** Uses the link's token. Null when it is unknown, used or expired. */
export async function consumeEmailLink(db: D1Database, token: string, now: number): Promise<FinishedEmailSignIn | null> {
  if (!token || token.length > 128) return null;
  const row = await db
    .prepare("DELETE FROM email_logins WHERE token_hash = ? RETURNING email, next_path, expires_at")
    .bind(await sha256hex(token))
    .first<{ email: string; next_path: string | null; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  return { email: row.email, nextPath: row.next_path };
}

export type CodeCheck =
  | ({ ok: true } & FinishedEmailSignIn)
  | { ok: false; reason: "wrong_code"; remaining: number; email: string }
  | { ok: false; reason: "expired" };

/**
 * Checks a code for one sign-in. Each try is counted before the comparison,
 * in one statement, so parallel guesses can't get more than their share.
 */
export async function checkEmailCode(db: D1Database, loginId: string, code: string, now: number): Promise<CodeCheck> {
  const clean = code.replace(/\s+/g, "");
  if (!/^eml_[A-Za-z0-9_-]{22}$/.test(loginId)) return { ok: false, reason: "expired" };
  const row = await db
    .prepare(
      `UPDATE email_logins SET attempts = attempts + 1
       WHERE id = ? AND attempts < ? AND expires_at > ?
       RETURNING email, code_hash, next_path, attempts`,
    )
    .bind(loginId, CODE_MAX_ATTEMPTS, now)
    .first<{ email: string; code_hash: string; next_path: string | null; attempts: number }>();
  if (!row) return { ok: false, reason: "expired" };
  const matches = /^\d{6}$/.test(clean) && (await timingSafeEqual(await codeHash(loginId, clean), row.code_hash));
  if (!matches) {
    const remaining = CODE_MAX_ATTEMPTS - row.attempts;
    if (remaining > 0) return { ok: false, reason: "wrong_code", remaining, email: row.email };
    // The last allowed try: spent, and counted like any wrong code.
    return { ok: false, reason: "wrong_code", remaining: 0, email: row.email };
  }
  // Single use: whoever deletes the row finishes the sign-in.
  const used = await db.prepare("DELETE FROM email_logins WHERE id = ? RETURNING id").bind(loginId).first();
  if (!used) return { ok: false, reason: "expired" };
  return { ok: true, email: row.email, nextPath: row.next_path };
}

/** The email for one sign-in: the code first (it shows in phone notifications), then the link. */
export function signInEmail(input: { code: string; link: string; newAccount: boolean }): { subject: string; text: string; html: string } {
  const intro = input.newAccount ? "Here is your code to finish signing up for OpenPing Hosted." : "Here is your code to sign in to OpenPing Hosted.";
  const subject = `${input.code} is your OpenPing sign-in code`;
  const text = [
    intro,
    "",
    `Code: ${input.code}`,
    "",
    `Or open this link on this device: ${input.link}`,
    "",
    "The code and the link work once, for 15 minutes.",
    "If you didn't ask for this, you can ignore this email; nobody can sign in without it.",
    "",
    "-- ",
    "OpenPing Hosted. Questions? support@n8builds.dev",
  ].join("\n");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f8fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #d8e0ea;border-radius:14px;">
<tr><td style="padding:28px 24px;font-family:${font};color:#16233a;">
<p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#475569;">OpenPing Hosted</p>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${escapeHtml(intro)}</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(input.code)}</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#3b5bdb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Sign in on this device</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#475569;">The code and the link work once, for 15 minutes.</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#475569;">If you didn't ask for this, you can ignore this email; nobody can sign in without it.</p>
</td></tr></table>
<p style="margin:16px 0 0;font-family:${font};font-size:12px;color:#5f6f87;">Questions? <a href="mailto:support@n8builds.dev" style="color:#3b5bdb;">support@n8builds.dev</a></p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

/** The notice every account gets when a passkey is added to it. */
export function passkeyAddedEmail(input: { label: string; at: number; accountUrl: string }): { subject: string; text: string; html: string } {
  const subject = "A passkey was added to your OpenPing Hosted account";
  const when = `${new Date(input.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const intro = `A passkey named "${input.label}" was added to your OpenPing Hosted account at ${when}.`;
  const warning = "If that wasn't you, someone can read this inbox: remove the passkey on your account page, change your email password, and write to support@n8builds.dev.";
  const text = [intro, "", warning, "", `Your account: ${input.accountUrl}`, "", "-- ", "OpenPing Hosted. Questions? support@n8builds.dev"].join("\n");
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f8fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #d8e0ea;border-radius:14px;">
<tr><td style="padding:28px 24px;font-family:${font};color:#16233a;">
<p style="margin:0 0 20px;font-size:14px;font-weight:600;color:#475569;">OpenPing Hosted</p>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${escapeHtml(intro)}</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#475569;">${escapeHtml(warning)}</p>
<p style="margin:0;"><a href="${escapeHtml(input.accountUrl)}" style="display:inline-block;background:#3b5bdb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Open your account</a></p>
</td></tr></table>
<p style="margin:16px 0 0;font-family:${font};font-size:12px;color:#5f6f87;">Questions? <a href="mailto:support@n8builds.dev" style="color:#3b5bdb;">support@n8builds.dev</a></p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Spent and expired sign-ins, for the cron's cleanup. */
export function emailSignInCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM email_logins WHERE expires_at <= ?").bind(now);
}
