/**
 * Deleting an account: by the customer on their account page, or by the
 * owner for a support request. The privacy policy (section 10) promises it.
 *
 * The request (`requestAccountDeletion`) does what must happen at once:
 *   - cancels the account's Stripe subscriptions, so nothing renews;
 *   - pauses its OpenPing (the owner's suspension columns, which billing can
 *     never lift), so checks stop and its pages go offline within 30 seconds;
 *   - closes the account (`disabled_at`) and ends every session, so nobody
 *     can sign in to it any more;
 *   - records it in the audit log and emails the account.
 *
 * The lifecycle jobs then finish it (`advanceAccountDeletions`), a step per
 * run, never losing data by mistake:
 *   1. the OpenPing is exported first, and the export read back from R2,
 *      exactly as for a lapsed plan (decisions D8 and D12); then its Worker
 *      and database are deleted. The export is kept 30 days, so support can
 *      restore it if the customer writes in time, and then it is deleted with
 *      its copy of the key.
 *   2. Once the OpenPing is gone, the account is scrubbed: its sign-in
 *      methods, sessions, sign-ins and email changes in flight, rate-limit
 *      counters and billing lock, its waitlist entry, and its email address,
 *      after one last email saying it is done. The row itself stays,
 *      anonymous, because the billing records tax law makes us keep
 *      (`subscriptions`, Stripe's customer id) point at it; the audit log
 *      keeps its entries for two years (src/audit-retention.ts).
 */

import { accountDeletedEmail, accountDeletionStartedEmail } from "./emails";
import { PLATFORM_REPLY_TO, type Mailer } from "./mail";
import type { StripeApi } from "./billing/stripe";
import { forgetTenant } from "./tenants";
import { log } from "./log";

export type DeletionRequester = "customer" | "owner";

/** The owner's suspension reason while an account is being deleted (the console shows it). */
export const DELETION_SUSPENSION_REASON = "Being deleted at the account's request";

/** Stripe statuses that can still charge: everything but these is cancelled. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

export type DeletionRequest =
  | { ok: true; email: string }
  | { ok: false; reason: "not_found" | "already" | "billing_unavailable" | "billing_failed" };

export interface DeletionDeps {
  db: D1Database;
  /** Stripe, when billing is set up; an account with a live subscription can't be deleted without it. */
  stripe: StripeApi | null;
  mailer: Mailer | null;
  now: number;
}

/** Starts the deletion: see the file's comment for what happens at once. */
export async function requestAccountDeletion(deps: DeletionDeps, input: { accountId: string; by: DeletionRequester; actorAccountId: string; reason?: string }): Promise<DeletionRequest> {
  const { db, now } = deps;
  const account = await db
    .prepare("SELECT email, deletion_requested_at FROM accounts WHERE id = ? AND deleted_at IS NULL")
    .bind(input.accountId)
    .first<{ email: string; deletion_requested_at: number | null }>();
  if (!account) return { ok: false, reason: "not_found" };
  if (account.deletion_requested_at !== null) return { ok: false, reason: "already" };

  // Nothing renews once the account is going. Stripe first: if it fails, nothing else has changed.
  const subs = await db
    .prepare("SELECT stripe_subscription_id, status FROM subscriptions WHERE account_id = ? AND stripe_subscription_id IS NOT NULL")
    .bind(input.accountId)
    .all<{ stripe_subscription_id: string; status: string }>();
  const live = subs.results.filter((s) => !ENDED.has(s.status));
  if (live.length && !deps.stripe) return { ok: false, reason: "billing_unavailable" };
  for (const s of live) {
    try {
      await deps.stripe!.cancelSubscription(s.stripe_subscription_id, `account-deletion-${s.stripe_subscription_id}`);
    } catch (error) {
      log.error("account.deletion_cancel_failed", { account: input.accountId, error });
      return { ok: false, reason: "billing_failed" };
    }
  }

  const marked = await db
    .prepare(
      `UPDATE accounts SET deletion_requested_at = ?1, deletion_requested_by = ?2, disabled_at = COALESCE(disabled_at, ?1), updated_at = ?1
       WHERE id = ?3 AND deletion_requested_at IS NULL AND deleted_at IS NULL`,
    )
    .bind(now, input.by, input.accountId)
    .run();
  if ((marked.meta.changes ?? 0) === 0) return { ok: false, reason: "already" };
  const tenants = await db
    .prepare(
      `UPDATE tenants SET owner_suspended_at = COALESCE(owner_suspended_at, ?1), owner_suspended_reason = COALESCE(owner_suspended_reason, ?2), updated_at = ?1
       WHERE account_id = ?3 AND provision_state <> 'deleting' RETURNING id, slug`,
    )
    .bind(now, DELETION_SUSPENSION_REASON, input.accountId)
    .all<{ id: string; slug: string }>();
  for (const t of tenants.results) forgetTenant(t.slug);
  await db.batch([
    db.prepare("DELETE FROM platform_sessions WHERE account_id = ?").bind(input.accountId),
    db
      .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, ?, 'account.deletion_requested', ?)")
      .bind(
        now,
        input.accountId,
        tenants.results[0]?.id ?? null,
        input.by,
        JSON.stringify({ by: input.actorAccountId, ...(input.reason ? { reason: input.reason } : {}), cancelled: live.map((s) => s.stripe_subscription_id) }),
      ),
  ]);
  if (deps.mailer) {
    const sent = await deps.mailer.send({
      to: account.email,
      ...accountDeletionStartedEmail({ at: now, byOwner: input.by === "owner", hadOpenPing: tenants.results.length > 0 }),
      category: "account_deletion",
      replyTo: PLATFORM_REPLY_TO,
    });
    if (!sent.ok) log.error("account.deletion_notice_not_sent", { account: input.accountId, error: sent.error });
  }
  return { ok: true, email: account.email };
}

/** Accounts whose deletion is in progress, oldest first (the partial index of migration 0015). */
export const DELETING_ACCOUNTS_SQL = `SELECT id, email, deletion_requested_at FROM accounts INDEXED BY idx_accounts_deleting
  WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL ORDER BY deletion_requested_at LIMIT ?`;

export interface DeletingAccount {
  id: string;
  email: string;
  deletion_requested_at: number;
}

/** The tenant of an account being deleted, if it still has one. */
export async function tenantOfDeletingAccount(db: D1Database, accountId: string) {
  return db
    .prepare("SELECT id, slug, provision_state, provisioned_at FROM tenants WHERE account_id = ? ORDER BY created_at LIMIT 1")
    .bind(accountId)
    .first<{ id: string; slug: string; provision_state: string; provisioned_at: number | null }>();
}

/**
 * The last step, once the account has no OpenPing left: one last email,
 * then everything that says who it was goes. Answers false when another run
 * finished it first.
 */
export async function scrubAccount(db: D1Database, mailer: Mailer | null, account: DeletingAccount, now: number): Promise<boolean> {
  // The email first, while the address is known; at most once (Resend's idempotency key covers a retried run).
  if (mailer) {
    const sent = await mailer.send({
      to: account.email,
      ...accountDeletedEmail({ at: now }),
      category: "account_deleted",
      replyTo: PLATFORM_REPLY_TO,
      idempotencyKey: `account-deleted-${account.id}`,
    });
    if (!sent.ok) log.error("account.deleted_notice_not_sent", { account: account.id, error: sent.error });
  }
  const id = account.id;
  const results = await db.batch([
    db.prepare("DELETE FROM platform_sessions WHERE account_id = ?").bind(id),
    db.prepare("DELETE FROM account_identities WHERE account_id = ?").bind(id),
    db.prepare("DELETE FROM auth_ceremonies WHERE account_id = ?").bind(id),
    db.prepare("DELETE FROM email_changes WHERE account_id = ?").bind(id),
    db.prepare("DELETE FROM email_logins WHERE email = ?").bind(account.email),
    db.prepare("DELETE FROM billing_locks WHERE account_id = ?").bind(id),
    db.prepare("DELETE FROM waitlist_entries WHERE email = ?").bind(account.email),
    // Counters name the address or the account: "<scope>:<subject>:<window>".
    db.prepare("DELETE FROM rate_limits WHERE instr(key, ':' || ?1 || ':') > 0 OR instr(key, ':' || ?2 || ':') > 0").bind(account.email, id),
    db
      .prepare(
        `UPDATE accounts SET email = 'deleted-' || id || '@deleted.invalid', name = NULL, webauthn_handle = NULL, checkout_session_id = NULL,
           disabled_at = COALESCE(disabled_at, ?1), deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL`,
      )
      .bind(now, id),
    db.prepare("INSERT INTO audit_events (at, account_id, actor, action, detail) VALUES (?, ?, 'system', 'account.deleted', ?)").bind(now, id, JSON.stringify({ requestedAt: account.deletion_requested_at })),
  ]);
  return (results[8]?.meta.changes ?? 0) > 0;
}
