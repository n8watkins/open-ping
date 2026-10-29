/**
 * Platform accounts: one per customer, found by email, with its sign-in
 * methods as rows in account_identities (decision D3).
 */

import { newId } from "../../src/worker/lib/ids";

export interface Account {
  id: string;
  email: string;
  name: string | null;
  disabledAt: number | null;
  webauthnHandle: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  disabled_at: number | null;
  webauthn_handle: string | null;
}

const ACCOUNT_COLUMNS = "id, email, name, disabled_at, webauthn_handle";

function fromRow(row: AccountRow): Account {
  return { id: row.id, email: row.email, name: row.name, disabledAt: row.disabled_at, webauthnHandle: row.webauthn_handle };
}

/** RFC 5321 caps an address at 254 characters; one @, something on each side, a dot in the domain. */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Trimmed and lowercased, or null when it isn't a plausible address. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * Throwaway-mail domains seen most in sign-up abuse (build plan, section
 * 10). Not exhaustive on purpose: it raises the cost of mass trials, and the
 * per-IP limits do the rest.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com", "dispostable.com", "fakeinbox.com", "getnada.com", "guerrillamail.com",
  "guerrillamail.net", "maildrop.cc", "mailinator.com", "mailnesia.com", "mintemail.com",
  "mohmal.com", "sharklasers.com", "temp-mail.org", "tempmail.com", "tempmailo.com",
  "throwawaymail.com", "trashmail.com", "yopmail.com",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return DISPOSABLE_DOMAINS.has(domain);
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  return row ? fromRow(row) : null;
}

export async function findAccountByEmail(db: D1Database, email: string): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE email = ?`).bind(email).first<AccountRow>();
  return row ? fromRow(row) : null;
}

/**
 * The account for a verified email, created (with its email identity) when
 * there is none. `create` null (sign-ups closed) answers null instead; when
 * set, a new account records the Terms' version its sign-up page showed and
 * when it was accepted (migration 0011).
 */
export async function accountForVerifiedEmail(
  db: D1Database,
  email: string,
  now: number,
  create: { termsVersion: string } | null,
): Promise<{ account: Account; created: boolean } | null> {
  const existing = await findAccountByEmail(db, email);
  if (existing) return { account: existing, created: false };
  if (!create) return null;
  const id = newId("acc");
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts (id, email, created_at, updated_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING",
      )
      .bind(id, email, now, now, create.termsVersion, now),
    db
      .prepare(
        `INSERT INTO account_identities (id, account_id, kind, subject, created_at)
         SELECT ?, id, 'email', email, ? FROM accounts WHERE email = ?
         ON CONFLICT(kind, subject) DO NOTHING`,
      )
      .bind(newId("idn"), now, email),
  ]);
  // Another sign-in may have created it a moment ago; either way this is the account.
  const account = await findAccountByEmail(db, email);
  if (!account) throw new Error("account was not created");
  return { account, created: account.id === id };
}

export async function touchIdentity(db: D1Database, accountId: string, kind: string, subject: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE account_identities SET last_used_at = ? WHERE account_id = ? AND kind = ? AND subject = ?")
    .bind(now, accountId, kind, subject)
    .run();
}

export async function audit(
  db: D1Database,
  input: { accountId: string | null; tenantId?: string | null; actor: "customer" | "system" | "support" | "owner"; action: string; detail?: Record<string, unknown>; now: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(input.now, input.accountId, input.tenantId ?? null, input.actor, input.action, input.detail ? JSON.stringify(input.detail) : null)
    .run();
}
