/**
 * The subscription state machine: what Stripe says about an account's
 * subscriptions becomes its tenant's billing state (tenants.status, .plan and
 * .billing_reason), which every call's props carry (the contract, section 3).
 *
 *   no subscription, trial running      trial        (30 days, 5 monitors, no card)
 *   no subscription, trial over         suspended    reason trial_ended (the sweep below)
 *   active or trialing                  active       plan hosted, or hosted_fast with the add-on,
 *                                                    and the packs it carries (decision D13)
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
 * The packs are the subscription's item quantities (a monitor pack, a fast
 * monitor pack), held to their caps, and fast packs count only with the
 * add-on; the tenant's limits are its plan's plus its packs
 * (planLimitsWithPacks), so they reach its OpenPing on its next call. A
 * downgrade (fewer packs, the add-on gone) never deletes anything there.
 *
 * Plan changes apply only from here, which only the signed webhook and the
 * trial sweep reach, never from the browser (build plan, section 10).
 * Billing writes only its own columns: the owner's suspension
 * (owner_suspended_*) is never read or written here, so a payment can't lift
 * it, and tenantFromRow keeps a tenant suspended while either says so.
 */

import { PACKS, packsForPlan, type PackQuantities, type PlanId, type TenantStatus } from "../../../src/shared/hosted-contract";
import { forgetTenant } from "../tenants";
import { BillingLockLostError, HOLDS, holdsBinds, type BillingLock } from "./lock";
import type { BillingConfig } from "./config";
import type { StripeInvoice, StripeSubscription, StripeSubscriptionItem, SubscriptionStatus } from "./stripe";

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

/** How many of a price the items carry (a quantity Stripe leaves out is 1). */
function quantityOf(items: readonly Pick<StripeSubscriptionItem, "price" | "quantity">[], price: string): number {
  let n = 0;
  for (const item of items) {
    if (item.price.id !== price) continue;
    const q = item.quantity ?? 1;
    n += Number.isSafeInteger(q) && q > 0 ? q : 0;
  }
  return n;
}

export interface SubscriptionPacks {
  /** As they count on `plan`: each within its cap, and fast packs only with the add-on. */
  packs: PackQuantities;
  /** What Stripe bills, by its own quantities (the renewal total, and packs to offer to remove). */
  billed: { fast: number; monitor_pack: number; fast_pack: number };
  /** What didn't fit, for the owner to look at: over a cap, or fast packs without the add-on. */
  problems: string[];
}

/**
 * The packs a subscription's items carry, as they count on `plan`. More than
 * a cap (a quantity changed in Stripe's dashboard), or fast packs without the
 * fast checks add-on, count as the cap or as none, and are named in
 * `problems` so the owner can put the subscription right.
 */
export function packsForItems(
  items: readonly Pick<StripeSubscriptionItem, "price" | "quantity">[],
  plan: PaidPlan,
  config: Pick<BillingConfig, "priceFast" | "priceMonitorPack" | "priceFastPack">,
): SubscriptionPacks {
  const asked = { monitors: quantityOf(items, config.priceMonitorPack), fast_monitors: quantityOf(items, config.priceFastPack) };
  const packs = packsForPlan(plan, asked);
  const problems: string[] = [];
  if (asked.monitors > PACKS.monitors.max) problems.push(`monitor_packs_over_cap:${asked.monitors}`);
  if (asked.fast_monitors > 0 && !PACKS.fast_monitors.plans.includes(plan)) problems.push(`fast_packs_without_add_on:${asked.fast_monitors}`);
  else if (asked.fast_monitors > PACKS.fast_monitors.max) problems.push(`fast_packs_over_cap:${asked.fast_monitors}`);
  const billed = { fast: quantityOf(items, config.priceFast), monitor_pack: asked.monitors, fast_pack: asked.fast_monitors };
  return { packs, billed, problems };
}

/** What a pending update would add, by kind, for the billing page. */
export type PendingItem = { kind: "fast" | "monitor_pack" | "fast_pack"; quantity: number };

export function pendingItemsOf(sub: StripeSubscription, config: Pick<BillingConfig, "priceFast" | "priceMonitorPack" | "priceFastPack">): PendingItem[] | null {
  const items = sub.pending_update?.subscription_items;
  if (!sub.pending_update || !items) return null;
  const out: PendingItem[] = [];
  for (const item of items) {
    const price = typeof item.price === "string" ? item.price : item.price?.id;
    const kind = price === config.priceFast ? "fast" : price === config.priceMonitorPack ? "monitor_pack" : price === config.priceFastPack ? "fast_pack" : null;
    if (kind) out.push({ kind, quantity: item.quantity ?? 1 });
  }
  return out;
}

/** What each kind of waiting change adds, in a sentence ("the payment for ..."). */
export const PENDING_TEXT: Record<PendingItem["kind"], string> = {
  fast: "1-minute checks",
  monitor_pack: "extra monitors",
  fast_pack: "extra fast monitors",
};

/** "1-minute checks", or "extra monitors and extra fast monitors": what a waiting change adds (plural, for "your ... weren't added"). */
export function pendingText(items: readonly PendingItem[]): string {
  const kinds = [...new Set(items.map((i) => i.kind))];
  return kinds.length ? kinds.map((k) => PENDING_TEXT[k]).join(" and ") : "the changes";
}

/** When the subscription renews: its items' billing period end (epoch ms). */
export function renewsAt(sub: StripeSubscription): number | null {
  const ends = sub.items.data.map((i) => i.current_period_end).filter((n) => Number.isSafeInteger(n));
  return ends.length ? Math.max(...ends) * 1000 : null;
}

/** The open invoice a pending update waits on, when Stripe expanded it. */
function pendingInvoice(sub: StripeSubscription): StripeInvoice | null {
  return sub.pending_update && sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
}

/**
 * Records the subscription as Stripe has it now (by Stripe's id, so a repeat
 * changes nothing), only while `lock` is held; throws BillingLockLostError
 * when it isn't.
 */
export async function saveSubscription(
  db: D1Database,
  lock: BillingLock,
  input: {
    sub: StripeSubscription;
    tenantId: string | null;
    plan: PaidPlan;
    packs: PackQuantities;
    billed: SubscriptionPacks["billed"];
    config: Pick<BillingConfig, "priceFast" | "priceMonitorPack" | "priceFastPack">;
    now: number;
  },
): Promise<void> {
  const { sub } = input;
  const pending = sub.pending_update ?? null;
  const waiting = pendingItemsOf(sub, input.config);
  const written = await db
    .prepare(
      `INSERT INTO subscriptions (id, account_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, plan, current_period_end,
         cancel_at_period_end, price_ids, ended_at, pending_until, pending_invoice_url, monitor_packs, fast_packs, pending_items, billed_items,
         created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?15, ?16, ?17, ?18, ?14, ?14 WHERE ${HOLDS}
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET account_id = excluded.account_id,
         tenant_id = COALESCE(excluded.tenant_id, subscriptions.tenant_id), stripe_customer_id = excluded.stripe_customer_id,
         status = excluded.status, plan = excluded.plan, current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end, price_ids = excluded.price_ids, ended_at = excluded.ended_at,
         monitor_packs = excluded.monitor_packs, fast_packs = excluded.fast_packs, pending_items = excluded.pending_items,
         billed_items = excluded.billed_items,
         pending_until = excluded.pending_until,
         pending_invoice_url = CASE WHEN excluded.pending_until IS NULL THEN NULL ELSE COALESCE(excluded.pending_invoice_url, subscriptions.pending_invoice_url) END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      `sub_${crypto.randomUUID()}`,
      lock.accountId,
      input.tenantId,
      sub.customer,
      sub.id,
      sub.status,
      input.plan,
      renewsAt(sub),
      sub.cancel_at_period_end ? 1 : 0,
      JSON.stringify(sub.items.data.map((i) => i.price.id)),
      sub.ended_at ? sub.ended_at * 1000 : null,
      pending ? pending.expires_at * 1000 : null,
      pendingInvoice(sub)?.hosted_invoice_url ?? null,
      input.now,
      input.packs.monitors,
      input.packs.fast_monitors,
      waiting && waiting.length ? JSON.stringify(waiting) : null,
      JSON.stringify(input.billed),
      ...holdsBinds(lock),
    )
    .run();
  if ((written.meta.changes ?? 0) === 0) throw new BillingLockLostError(lock.accountId);
}

/** The plan a subscription row was saved with, for one whose prices aren't ours any more. */
export async function savedPlan(db: D1Database, stripeSubscriptionId: string): Promise<PaidPlan | null> {
  const row = await db.prepare("SELECT plan FROM subscriptions WHERE stripe_subscription_id = ?").bind(stripeSubscriptionId).first<{ plan: PaidPlan }>();
  return row?.plan ?? null;
}

export interface BillingChange {
  tenantId: string;
  slug: string;
  from: { status: TenantStatus; plan: PlanId; reason: string | null; packs: PackQuantities };
  to: { status: TenantStatus; plan: PlanId; reason: BillingReason | null; packs: PackQuantities };
}

/**
 * Brings the account's tenant to what its subscriptions say. Answers the
 * change, or null when there was nothing to change (no tenant, no deciding
 * subscription, or already there). The tenant's next call carries it: this
 * isolate forgets its cached row at once, the others within 30 seconds.
 */
export async function applyAccountBilling(db: D1Database, lock: BillingLock, now: number): Promise<BillingChange | null> {
  const accountId = lock.accountId;
  const [tenantRows, subRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT id, slug, status, plan, billing_reason, monitor_packs, fast_packs FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1",
      )
      .bind(accountId),
    db.prepare("SELECT status, plan, monitor_packs, fast_packs FROM subscriptions WHERE account_id = ? ORDER BY updated_at DESC").bind(accountId),
  ]);
  const tenant = tenantRows!.results[0] as
    | { id: string; slug: string; status: TenantStatus; plan: PlanId; billing_reason: string | null; monitor_packs: number; fast_packs: number }
    | undefined;
  if (!tenant) return null;
  let best: { state: BillingState; plan: PaidPlan; packs: PackQuantities; rank: number } | null = null;
  for (const row of subRows!.results as { status: SubscriptionStatus; plan: PaidPlan; monitor_packs: number; fast_packs: number }[]) {
    const state = stateForStatus(row.status);
    const rank = RANK[row.status] ?? 0;
    if (state && (!best || rank > best.rank)) {
      best = { state, plan: row.plan, packs: packsForPlan(row.plan, { monitors: row.monitor_packs, fast_monitors: row.fast_packs }), rank };
    }
  }
  if (!best) return null;
  const to = { status: best.state.status, plan: best.plan, reason: best.state.reason, packs: best.packs };
  const fromPacks: PackQuantities = { monitors: tenant.monitor_packs, fast_monitors: tenant.fast_packs };
  if (
    tenant.status === to.status &&
    tenant.plan === to.plan &&
    tenant.billing_reason === to.reason &&
    fromPacks.monitors === to.packs.monitors &&
    fromPacks.fast_monitors === to.packs.fast_monitors
  ) {
    return null;
  }
  const change: BillingChange = {
    tenantId: tenant.id,
    slug: tenant.slug,
    from: { status: tenant.status, plan: tenant.plan, reason: tenant.billing_reason, packs: fromPacks },
    to,
  };
  // One batch, both writes conditional on the lock: the state and its audit line land together or not at all.
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE tenants SET status = ?1, plan = ?2, billing_reason = ?3, monitor_packs = ?6, fast_packs = ?7,
           suspended_at = CASE WHEN ?1 = 'suspended' THEN COALESCE(suspended_at, ?4) ELSE NULL END, updated_at = ?4
         WHERE id = ?5 AND ${HOLDS}`,
      )
      .bind(to.status, to.plan, to.reason, now, tenant.id, to.packs.monitors, to.packs.fast_monitors, ...holdsBinds(lock)),
    db
      .prepare(`INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) SELECT ?, ?, ?, 'system', 'billing.changed', ? WHERE ${HOLDS}`)
      .bind(
        now,
        accountId,
        tenant.id,
        JSON.stringify({ from: billingText(change.from), to: billingText(to), reason: to.reason }),
        ...holdsBinds(lock),
      ),
  ]);
  if ((updated?.meta.changes ?? 0) === 0) throw new BillingLockLostError(accountId);
  forgetTenant(tenant.slug);
  return change;
}

/** "active/hosted_fast", with "+2 monitor packs, +1 fast pack" when it has packs: the audit line. */
function billingText(b: { status: TenantStatus; plan: PlanId; packs: PackQuantities }): string {
  const packs = [b.packs.monitors ? `+${b.packs.monitors} monitor` : "", b.packs.fast_monitors ? `+${b.packs.fast_monitors} fast` : ""].filter(Boolean);
  return `${b.status}/${b.plan}${packs.length ? ` (${packs.join(", ")} packs)` : ""}`;
}

/**
 * The trial sweep's query: trials whose end has passed. Its WHERE contains
 * the partial index's (idx_tenants_trial_end, migration 0006), and INDEXED BY
 * holds SQLite to it (otherwise it may pick idx_tenants_status and read every
 * trial), so only the ended trials are read (test/billing.test.ts checks the plan).
 */
export const ENDED_TRIALS_SQL = `SELECT id FROM tenants INDEXED BY idx_tenants_trial_end
  WHERE status = 'trial' AND trial_ends_at <= ?1 AND provision_state <> 'deleting' ORDER BY trial_ends_at LIMIT ?2`;

/**
 * From the every-minute cron: a trial past its 30 days, with no subscription,
 * is suspended by billing (reason trial_ended): its checks stop and its
 * pages go offline until the customer subscribes. Nothing is deleted here
 * (decision D8; the 30-day deletion is lifecycle's, B7).
 */
export async function endTrials(db: D1Database, now: number, limit = 100): Promise<{ tenantId: string; slug: string; accountId: string }[]> {
  const rows = await db
    .prepare(
      `UPDATE tenants SET status = 'suspended', billing_reason = 'trial_ended', suspended_at = ?1, updated_at = ?1
       WHERE id IN (${ENDED_TRIALS_SQL.replace("?2", "?3")}) AND status = 'trial'
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
