/**
 * The subscription state machine: what Stripe says about an account's
 * subscriptions becomes its tenant's billing state (tenants.status, .plan and
 * .billing_reason), which every call's props carry (the contract, section 3).
 *
 *   no subscription, trial running      trial        (14 days, 5 monitors, no card)
 *   no subscription, trial over         suspended    reason trial_ended (the sweep below)
 *   active or trialing                  active       plan hosted, or hosted_fast with the add-on
 *   past_due                            past_due     checks keep running while Stripe retries (dunning)
 *   unpaid                              suspended    reason unpaid: Stripe's retries ran out
 *   paused                              suspended    reason paused
 *   canceled                            suspended    reason canceled (checks stop at once; data kept 30 days, decision D8);
 *                                                    also the end of dunning: Stripe cancels after its last retry (decision D11)
 *   incomplete, incomplete_expired      no change    the first payment never went through
 *
 * With more than one subscription (two Checkouts finished), the best one
 * decides: active, then past_due, unpaid, paused, canceled.
 *
 * Plan changes apply only from here, which only the signed webhook and the
 * trial sweep reach, never from the browser (build plan, section 10).
 * Billing writes only its own columns: the owner's suspension
 * (owner_suspended_*) is never read or written here, so a payment can't lift
 * it, and tenantFromRow keeps a tenant suspended while either says so.
 */

import type { PlanId, TenantStatus } from "../../../src/shared/hosted-contract";
import { forgetTenant } from "../tenants";
import type { BillingConfig } from "./config";
import type { StripeSubscription, SubscriptionStatus } from "./stripe";

export type PaidPlan = Exclude<PlanId, "trial">;
export const BILLING_REASONS = ["trial_ended", "unpaid", "canceled", "paused"] as const;
export type BillingReason = (typeof BILLING_REASONS)[number];

export interface BillingState {
  status: TenantStatus;
  reason: BillingReason | null;
}

/** What a subscription in this status means for the tenant; null when it decides nothing. */
export function stateForStatus(status: SubscriptionStatus): BillingState | null {
  switch (status) {
    case "active":
    case "trialing":
      return { status: "active", reason: null };
    case "past_due":
      return { status: "past_due", reason: null };
    case "unpaid":
      return { status: "suspended", reason: "unpaid" };
    case "paused":
      return { status: "suspended", reason: "paused" };
    case "canceled":
      return { status: "suspended", reason: "canceled" };
    default:
      return null;
  }
}

const RANK: Record<string, number> = { active: 6, trialing: 6, past_due: 5, unpaid: 4, paused: 3, canceled: 2 };

/** The yearly plan, with or without the add-on; null for a subscription to anything else. */
export function planForPrices(priceIds: readonly string[], config: Pick<BillingConfig, "priceHosted" | "priceFast">): PaidPlan | null {
  if (!priceIds.includes(config.priceHosted)) return null;
  return priceIds.includes(config.priceFast) ? "hosted_fast" : "hosted";
}

/** When the subscription renews: its items' billing period end (epoch ms). */
export function renewsAt(sub: StripeSubscription): number | null {
  const ends = sub.items.data.map((i) => i.current_period_end).filter((n) => Number.isSafeInteger(n));
  return ends.length ? Math.max(...ends) * 1000 : null;
}

/** Records the subscription as Stripe has it now (by Stripe's id, so a repeat changes nothing). */
export async function saveSubscription(
  db: D1Database,
  input: { sub: StripeSubscription; accountId: string; tenantId: string | null; plan: PaidPlan; now: number },
): Promise<void> {
  const { sub } = input;
  await db
    .prepare(
      `INSERT INTO subscriptions (id, account_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, plan, current_period_end,
         cancel_at_period_end, price_ids, ended_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET account_id = excluded.account_id,
         tenant_id = COALESCE(excluded.tenant_id, subscriptions.tenant_id), stripe_customer_id = excluded.stripe_customer_id,
         status = excluded.status, plan = excluded.plan, current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end, price_ids = excluded.price_ids, ended_at = excluded.ended_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      `sub_${crypto.randomUUID()}`,
      input.accountId,
      input.tenantId,
      sub.customer,
      sub.id,
      sub.status,
      input.plan,
      renewsAt(sub),
      sub.cancel_at_period_end ? 1 : 0,
      JSON.stringify(sub.items.data.map((i) => i.price.id)),
      sub.ended_at ? sub.ended_at * 1000 : null,
      input.now,
    )
    .run();
}

export interface BillingChange {
  tenantId: string;
  slug: string;
  from: { status: TenantStatus; plan: PlanId; reason: string | null };
  to: { status: TenantStatus; plan: PlanId; reason: BillingReason | null };
}

/**
 * Brings the account's tenant to what its subscriptions say. Answers the
 * change, or null when there was nothing to change (no tenant, no deciding
 * subscription, or already there). The tenant's next call carries it: this
 * isolate forgets its cached row at once, the others within 30 seconds.
 */
export async function applyAccountBilling(db: D1Database, accountId: string, now: number): Promise<BillingChange | null> {
  const [tenantRows, subRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT id, slug, status, plan, billing_reason FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
      .bind(accountId),
    db.prepare("SELECT status, plan FROM subscriptions WHERE account_id = ? ORDER BY updated_at DESC").bind(accountId),
  ]);
  const tenant = tenantRows!.results[0] as { id: string; slug: string; status: TenantStatus; plan: PlanId; billing_reason: string | null } | undefined;
  if (!tenant) return null;
  let best: { state: BillingState; plan: PaidPlan; rank: number } | null = null;
  for (const row of subRows!.results as { status: SubscriptionStatus; plan: PaidPlan }[]) {
    const state = stateForStatus(row.status);
    const rank = RANK[row.status] ?? 0;
    if (state && (!best || rank > best.rank)) best = { state, plan: row.plan, rank };
  }
  if (!best) return null;
  const to = { status: best.state.status, plan: best.plan, reason: best.state.reason };
  if (tenant.status === to.status && tenant.plan === to.plan && tenant.billing_reason === to.reason) return null;
  await db
    .prepare(
      `UPDATE tenants SET status = ?1, plan = ?2, billing_reason = ?3,
         suspended_at = CASE WHEN ?1 = 'suspended' THEN COALESCE(suspended_at, ?4) ELSE NULL END, updated_at = ?4
       WHERE id = ?5`,
    )
    .bind(to.status, to.plan, to.reason, now, tenant.id)
    .run();
  forgetTenant(tenant.slug);
  const change: BillingChange = { tenantId: tenant.id, slug: tenant.slug, from: { status: tenant.status, plan: tenant.plan, reason: tenant.billing_reason }, to };
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', 'billing.changed', ?)")
    .bind(now, accountId, tenant.id, JSON.stringify({ from: `${change.from.status}/${change.from.plan}`, to: `${to.status}/${to.plan}`, reason: to.reason }))
    .run();
  return change;
}

/**
 * The trial sweep's query: trials whose end has passed. Its WHERE contains
 * the partial index's (idx_tenants_trial_end, migration 0006), and INDEXED BY
 * holds SQLite to it (otherwise it may pick idx_tenants_status and read every
 * trial), so only the ended trials are read (test/billing.test.ts checks the plan).
 */
export const ENDED_TRIALS_SQL = `SELECT id FROM tenants INDEXED BY idx_tenants_trial_end
  WHERE status = 'trial' AND trial_ends_at <= ?1 ORDER BY trial_ends_at LIMIT ?2`;

/**
 * From the every-minute cron: a trial past its 14 days, with no subscription,
 * is suspended by billing (reason trial_ended): its checks stop and its
 * pages go offline until the customer subscribes. Nothing is deleted here
 * (decision D8; the 30-day deletion is lifecycle's, B7).
 */
export async function endTrials(db: D1Database, now: number, limit = 100): Promise<{ tenantId: string; slug: string; accountId: string }[]> {
  const rows = await db
    .prepare(
      `UPDATE tenants SET status = 'suspended', billing_reason = 'trial_ended', suspended_at = ?1, updated_at = ?1
       WHERE id IN (${ENDED_TRIALS_SQL.replace("?2", "?3")}) AND provision_state <> 'deleting'
       RETURNING id, slug, account_id`,
    )
    .bind(now, now, limit)
    .all<{ id: string; slug: string; account_id: string }>();
  const ended = rows.results.map((r) => ({ tenantId: r.id, slug: r.slug, accountId: r.account_id }));
  if (ended.length) {
    await db.batch(
      ended.map((t) =>
        db
          .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', 'billing.trial_ended', NULL)")
          .bind(now, t.accountId, t.tenantId),
      ),
    );
    for (const t of ended) forgetTenant(t.slug);
  }
  return ended;
}
