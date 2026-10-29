/**
 * Deleting an account: by the customer on their account page, or by the
 * owner for a support request. The privacy policy (section 10) promises it.
 *
 * The request (`requestAccountDeletion`) does what must happen at once:
 *   - records the request, which everything below can be finished from;
 *   - expires its open Checkout Session and cancels its Stripe
 *     subscriptions, so nothing starts or renews (what Stripe can't do now,
 *     the lifecycle job retries, and the account isn't scrubbed before; a
 *     subscription that starts anyway is cancelled and refunded by billing's
 *     webhook, src/billing/webhook.ts);
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
 *   2. Once the OpenPing is gone and nothing can charge it, the account is scrubbed: its sign-in
 *      methods, sessions, sign-ins and email changes in flight, rate-limit
 *      counters and billing lock, its waitlist entry, and its email address,
 *      after one last email saying it is done. The row itself stays,
 *      anonymous, because the billing records tax law makes us keep
 *      (`subscriptions`, Stripe's customer id) point at it; the audit log
 *      keeps its entries for two years (src/audit-retention.ts).
 */

import { accountDeletedEmail, accountDeletionStartedEmail } from "./emails";
import { PLATFORM_REPLY_TO, type Mailer } from "./mail";
import { StripeApiError, type StripeApi } from "./billing/stripe";
import { LIMITS } from "./auth/rate-limit";
import { forgetTenant } from "./tenants";
import { log } from "./log";

export type DeletionRequester = "customer" | "owner";

/** The owner's suspension reason while an account is being deleted (the console shows it). */
export const DELETION_SUSPENSION_REASON = "Being deleted at the account's request";

/** Stripe statuses that can still charge: everything but these is cancelled. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

export type DeletionRequest =
  | { ok: true; email: string; billingSettled: boolean }
  | { ok: false; reason: "not_found" | "already" };

export interface DeletionDeps {
  db: D1Database;
  /** Stripe, when billing is set up; without it the plan is cancelled by a later lifecycle run. */
  stripe: StripeApi | null;
  mailer: Mailer | null;
  now: number;
}

/**
 * Ends everything the account could still be charged for: its open
 * Checkout Session (expired, so it can't start a subscription later) and
 * every subscription Stripe could still charge (cancelled now, with
 * idempotency keys, so a retry is safe). Each one done is recorded as it
 * happens; answers whether nothing is left, so the lifecycle job retries
 * what failed (or what waited for Stripe to be set up) on its next run.
 */
export async function settleAccountBilling(db: D1Database, stripe: StripeApi | null, accountId: string, now: number): Promise<boolean> {
  const account = await db.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(accountId).first<{ checkout_session_id: string | null }>();
  const subs = await db
    .prepare("SELECT stripe_subscription_id, status FROM subscriptions WHERE account_id = ? AND stripe_subscription_id IS NOT NULL")
    .bind(accountId)
    .all<{ stripe_subscription_id: string; status: string }>();
  const live = subs.results.filter((s) => !ENDED.has(s.status));
  if (!account?.checkout_session_id && !live.length) return true;
  if (!stripe) return false;
  let settled = true;
  if (account?.checkout_session_id) {
    try {
      await stripe.expireCheckoutSession(account.checkout_session_id);
      await db.prepare("UPDATE accounts SET checkout_session_id = NULL WHERE id = ? AND checkout_session_id = ?").bind(accountId, account.checkout_session_id).run();
    } catch (error) {
      // Already complete or expired: Stripe refuses to expire it, and there is nothing left to stop.
      if (error instanceof StripeApiError && error.status === 400) {
        await db.prepare("UPDATE accounts SET checkout_session_id = NULL WHERE id = ? AND checkout_session_id = ?").bind(accountId, account.checkout_session_id).run();
      } else {
        log.error("account.deletion_checkout_expire_failed", { account: accountId, error });
        settled = false;
      }
    }
  }
  for (const s of live) {
    try {
      const cancelled = await stripe.cancelSubscription(s.stripe_subscription_id, `account-deletion-${s.stripe_subscription_id}`);
      // What Stripe now says; the webhook that follows writes the rest, as for any cancellation.
      await db
        .prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?")
        .bind(cancelled.status ?? "canceled", now, s.stripe_subscription_id)
        .run();
      await db
        .prepare("INSERT INTO audit_events (at, account_id, actor, action, detail) VALUES (?, ?, 'system', 'billing.cancelled_for_deletion', ?)")
        .bind(now, accountId, JSON.stringify({ subscription: s.stripe_subscription_id }))
        .run();
    } catch (error) {
      log.error("account.deletion_cancel_failed", { account: accountId, error });
      settled = false;
    }
  }
  return settled;
}

/**
 * Starts the deletion: see the file's comment for what happens at once. The
 * intent is recorded first, so a Stripe failure part way leaves an account
 * the lifecycle job finishes cancelling, never one half asked for.
 */
export async function requestAccountDeletion(deps: DeletionDeps, input: { accountId: string; by: DeletionRequester; actorAccountId: string; reason?: string }): Promise<DeletionRequest> {
  const { db, now } = deps;
  const account = await db
    .prepare("SELECT email, deletion_requested_at FROM accounts WHERE id = ? AND deleted_at IS NULL")
    .bind(input.accountId)
    .first<{ email: string; deletion_requested_at: number | null }>();
  if (!account) return { ok: false, reason: "not_found" };
  if (account.deletion_requested_at !== null) return { ok: false, reason: "already" };

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
      .bind(now, input.accountId, tenants.results[0]?.id ?? null, input.by, JSON.stringify({ by: input.actorAccountId, ...(input.reason ? { reason: input.reason } : {}) })),
  ]);
  const billingSettled = await settleAccountBilling(db, deps.stripe, input.accountId, now);
  if (deps.mailer) {
    const sent = await deps.mailer.send({
      to: account.email,
      ...accountDeletionStartedEmail({ at: now, byOwner: input.by === "owner", hadOpenPing: tenants.results.length > 0 }),
      category: "account_deletion",
      replyTo: PLATFORM_REPLY_TO,
    });
    if (!sent.ok) log.error("account.deletion_notice_not_sent", { account: input.accountId, error: sent.error });
  }
  return { ok: true, email: account.email, billingSettled };
}

/** Accounts whose deletion is in progress, oldest first (the partial index of migration 0016). */
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
    // Counters are "<scope>:<subject>:<window>": a range of the primary key per scope that names an address or an account.
    ...rateLimitScrub(db, account.email, id),
    // The history stays its two years (src/audit-retention.ts), without the addresses in it:
    // its security record is no longer kept for an account that is gone.
    db
      .prepare(
        `UPDATE audit_events SET kept = 0, detail = CASE WHEN detail IS NULL THEN NULL ELSE json_remove(detail, '$.from', '$.to', '$.address', '$.email') END
         WHERE account_id = ?1 OR tenant_id IN (SELECT DISTINCT tenant_id FROM audit_events WHERE account_id = ?1 AND tenant_id IS NOT NULL)`,
      )
      .bind(id),
    db
      .prepare(
        `UPDATE accounts SET email = 'deleted-' || id || '@deleted.invalid', name = NULL, webauthn_handle = NULL, checkout_session_id = NULL,
           disabled_at = COALESCE(disabled_at, ?1), deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL`,
      )
      .bind(now, id),
    db.prepare("INSERT INTO audit_events (at, account_id, actor, action, detail) VALUES (?, ?, 'system', 'account.deleted', ?)").bind(now, id, JSON.stringify({ requestedAt: account.deletion_requested_at })),
  ]);
  return (results.at(-2)?.meta.changes ?? 0) > 0;
}

/** The rate-limit counters that name `email` or `accountId`, by key range (the primary key), one statement per scope. */
export function rateLimitScrub(db: D1Database, email: string, accountId: string): D1PreparedStatement[] {
  return Object.values(LIMITS).flatMap((rule) => {
    const subject = rule.scope.endsWith(":address") ? email : rule.scope.endsWith(":account") ? accountId : null;
    if (!subject) return [];
    // Every key of this subject starts with "<scope>:<subject>:"; ";" is the character after ":".
    const prefix = `${rule.scope}:${subject}`;
    return [db.prepare("DELETE FROM rate_limits WHERE key >= ? AND key < ?").bind(`${prefix}:`, `${prefix};`)];
  });
}
