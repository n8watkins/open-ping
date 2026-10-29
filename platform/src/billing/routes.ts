/**
 * The customer's billing routes on app.<domain>, inside the account routes
 * (so the session and the same-origin check on every post apply):
 *
 *   GET  /billing           the plan, renewal, and what can be done
 *   GET  /billing/upgrade   the same, leading with the next plan up (the tenant's 402 answers link here)
 *   POST /billing/checkout  Stripe Checkout for the yearly plan, with or without 1-minute checks, and any packs
 *   POST /billing/portal    Stripe's Customer Portal: card, invoices, cancel
 *   POST /billing/add-fast  adds 1-minute checks to a paid plan
 *   POST /billing/packs     sets how many of a pack (25 monitors, 5 fast monitors) a paid plan has
 *
 * /billing/upgrade takes `?need=<limit kind>` from the tenant's 402 answers
 * (upgradeUrlFor in the contract) and leads with what lifts that limit.
 *
 * Nothing here changes a plan or a status: those follow the signed webhook
 * (./webhook.ts). A post that goes on to Stripe answers a page that goes on
 * by GET (continuePage), since the CSP's form-action 'self' blocks a post's
 * redirect to another origin.
 */

import type { Context, Hono } from "hono";

import { continuePage } from "../account-pages";
import type { Session } from "../auth/sessions";
import type { PlatformEnv } from "../env";
import { requestAppOrigin } from "../hosts";
import type { BillingSetup } from "./config";
import { billingPage, type BillingView } from "./pages";
import { BILLING_REASONS, type BillingReason, type PendingItem } from "./state";
import { BillingBusyError, withBillingLock } from "./lock";
import { StripeApiError, type StripeSubscription } from "./stripe";
import {
  LIMIT_KINDS,
  PACKS,
  PACK_KINDS,
  PLAN_IDS,
  TENANT_STATUSES,
  UPGRADE_NEED_PARAM,
  packsForPlan,
  type LimitKind,
  type PackKind,
  type PlanId,
  type TenantStatus,
} from "../../../src/shared/hosted-contract";
import { effectiveLimits, parseLimitOverrides } from "../tenants";
import { log } from "../log";

type Env = { Bindings: PlatformEnv; Variables: { session: Session | null; now: number } };
type Ctx = Context<Env>;

export interface BillingDeps {
  billing(env: PlatformEnv): BillingSetup;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, ...NO_STORE } });
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function pendingItemsFrom(json: string | null): PendingItem[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (i): i is PendingItem =>
        !!i && typeof i === "object" && ["fast", "monitor_pack", "fast_pack"].includes((i as PendingItem).kind) && Number.isSafeInteger((i as PendingItem).quantity),
    );
  } catch {
    return [];
  }
}

/** Everything the billing section shows for an account: three reads, one round trip. */
export async function billingView(db: D1Database, accountId: string, available: boolean, now: number): Promise<BillingView> {
  const [tenantRows, subRows, accountRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT t.status, t.plan, t.billing_reason, t.trial_ends_at, t.monitor_packs, t.fast_packs, t.limit_overrides,
                u.monitors AS used_monitors, u.fast_monitors AS used_fast, u.status_pages AS used_pages
         FROM tenants t LEFT JOIN tenant_usage u ON u.tenant_id = t.id
         WHERE t.account_id = ? AND t.provision_state <> 'deleting' ORDER BY t.created_at LIMIT 1`,
      )
      .bind(accountId),
    db
      .prepare(
        `SELECT status, current_period_end, cancel_at_period_end, ended_at, payment_failed_at, next_payment_attempt, pending_until, pending_invoice_url,
           pending_items FROM subscriptions
         WHERE account_id = ? ORDER BY CASE status WHEN 'active' THEN 6 WHEN 'trialing' THEN 6 WHEN 'past_due' THEN 5 WHEN 'unpaid' THEN 4
           WHEN 'paused' THEN 3 WHEN 'canceled' THEN 2 ELSE 0 END DESC, updated_at DESC LIMIT 1`,
      )
      .bind(accountId),
    db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(accountId),
  ]);
  const t = tenantRows!.results[0] as
    | {
        status: string;
        plan: string;
        billing_reason: string | null;
        trial_ends_at: number | null;
        monitor_packs: number | null;
        fast_packs: number | null;
        limit_overrides: string | null;
        used_monitors: number | null;
        used_fast: number | null;
        used_pages: number | null;
      }
    | undefined;
  const s = subRows!.results[0] as
    | {
        status: string;
        current_period_end: number | null;
        cancel_at_period_end: number;
        ended_at: number | null;
        payment_failed_at: number | null;
        next_payment_attempt: number | null;
        pending_until: number | null;
        pending_invoice_url: string | null;
        pending_items: string | null;
      }
    | undefined;
  const a = accountRows!.results[0] as { stripe_customer_id: string | null } | undefined;
  const plan = oneOf<PlanId>(PLAN_IDS, t?.plan, "trial");
  const packs = packsForPlan(plan, { monitors: t?.monitor_packs, fast_monitors: t?.fast_packs });
  return {
    available,
    hasTenant: !!t,
    status: oneOf<TenantStatus>(TENANT_STATUSES, t?.status, "trial"),
    plan,
    packs,
    // What the tenant's OpenPing is told, the same function as its props.
    limits: effectiveLimits({ plan, packs, limitOverrides: parseLimitOverrides(t?.limit_overrides ?? null) }),
    usage:
      t && t.used_monitors !== null
        ? { monitors: t.used_monitors, fastMonitors: t.used_fast, statusPages: t.used_pages ?? 0 }
        : null,
    reason: (BILLING_REASONS as readonly unknown[]).includes(t?.billing_reason) ? (t!.billing_reason as BillingReason) : null,
    trialEndsAt: t?.trial_ends_at ?? null,
    subscription: s
      ? {
          status: s.status,
          renewsAt: s.current_period_end,
          cancelAtPeriodEnd: s.cancel_at_period_end === 1,
          endedAt: s.ended_at,
          paymentFailedAt: s.payment_failed_at,
          nextPaymentAttempt: s.next_payment_attempt,
          // Only a pending change Stripe still keeps, with its invoice to pay.
          pending:
            s.pending_until && s.pending_until > now && s.pending_invoice_url
              ? { until: s.pending_until, invoiceUrl: s.pending_invoice_url, items: pendingItemsFrom(s.pending_items) }
              : null,
        }
      : null,
    hasCustomer: !!a?.stripe_customer_id,
  };
}

const FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
  welcome: { message: "Thanks! Your payment went through; your plan changes as soon as Stripe confirms it, usually within a few seconds.", tone: "ok" },
  upgrading: { message: "1-minute checks are on their way: they start as soon as Stripe confirms the payment.", tone: "ok" },
  "already-paid": { message: "You already have a paid plan; change it from Manage billing.", tone: "ok" },
  "no-plan": { message: "There's no paid plan to add 1-minute checks to yet. Subscribe first.", tone: "error" },
  "already-fast": { message: "You already have 1-minute checks.", tone: "ok" },
  "stripe-error": { message: "We couldn't reach Stripe just now. Nothing was charged; please try again in a minute.", tone: "error" },
  "card-declined": { message: "Stripe couldn't take the payment, so nothing changed. Update your card in Manage billing and try again.", tone: "error" },
  "no-customer": { message: "There's no billing history yet: subscribe first.", tone: "error" },
  busy: { message: "Your billing is being updated right now. Please try again in a moment.", tone: "error" },
  "add-pending": { message: "1-minute checks are waiting on your payment: finish it below to add them.", tone: "error" },
  "packs-added": { message: "More monitors are on their way: your limits go up as soon as Stripe confirms the payment.", tone: "ok" },
  "packs-removed": { message: "Done: the pack comes off as soon as Stripe confirms, and the unused part of the year comes off your next renewal.", tone: "ok" },
  "bad-pack": { message: "That isn't a pack we sell. Nothing changed.", tone: "error" },
  "packs-unchanged": { message: "Your plan already has that many packs.", tone: "ok" },
  "packs-at-most": { message: "That's the most packs a plan can have. Write to support for more.", tone: "error" },
  "needs-fast": { message: "Fast monitor packs come with 1-minute checks. Add those first.", tone: "error" },
  "change-pending": { message: "An earlier change is waiting on its payment. Pay or wait for that invoice first.", tone: "error" },
};

export function registerBillingRoutes(app: Hono<Env>, deps: BillingDeps): void {
  const origin = (c: Ctx) => requestAppOrigin(c.req.url, c.env.HOSTED_DOMAIN);

  for (const [path, focus] of [
    ["/billing", "billing"],
    ["/billing/upgrade", "upgrade"],
  ] as const) {
    app.get(path, async (c) => {
      const session = c.get("session");
      if (!session) return seeOther(`/sign-in?next=${encodeURIComponent(path)}`);
      const setup = deps.billing(c.env);
      const view = await billingView(c.env.PLATFORM_DB, session.account.id, setup.ok, c.get("now"));
      const need = oneOf<LimitKind | "none">([...LIMIT_KINDS, "none"], c.req.query(UPGRADE_NEED_PARAM), "none");
      return billingPage({ view, now: c.get("now"), focus, need: need === "none" ? null : need, flash: FLASH[c.req.query("done") ?? ""] ?? null });
    });
  }

  /** The billing page again, with a message, for a post that can't go on. */
  async function back(c: Ctx, done: keyof typeof FLASH, status = 303): Promise<Response> {
    if (status === 303) return seeOther(`/billing?done=${done}`);
    const session = c.get("session")!;
    const view = await billingView(c.env.PLATFORM_DB, session.account.id, deps.billing(c.env).ok, c.get("now"));
    return billingPage({ view, now: c.get("now"), focus: "billing", flash: FLASH[done], status });
  }

  /** The account's Stripe Customer, made the first time (once: the idempotency key and the conditional save). */
  async function customerFor(c: Ctx, setup: Extract<BillingSetup, { ok: true }>, session: Session): Promise<string> {
    const db = c.env.PLATFORM_DB;
    const existing = await db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(session.account.id).first<{ stripe_customer_id: string | null }>();
    if (existing?.stripe_customer_id) return existing.stripe_customer_id;
    const customer = await setup.stripe.createCustomer({ email: session.account.email, accountId: session.account.id }, `customer-${session.account.id}`);
    await db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customer.id, session.account.id).run();
    const saved = await db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(session.account.id).first<{ stripe_customer_id: string }>();
    return saved!.stripe_customer_id;
  }

  async function decidingSubscription(db: D1Database, accountId: string) {
    return db
      .prepare(
        `SELECT stripe_subscription_id, status, plan FROM subscriptions WHERE account_id = ? AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<{ stripe_subscription_id: string; status: string; plan: string }>();
  }

  app.post("/billing/checkout", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther("/sign-in?next=%2Fbilling");
    const setup = deps.billing(c.env);
    if (!setup.ok) return seeOther("/billing");
    const db = c.env.PLATFORM_DB;
    const fields = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const plan = fields.plan === "hosted_fast" ? "hosted_fast" : "hosted";
    // Packs from the form, each held to its cap and to the plan it is sold with.
    const packs = packsForPlan(plan, { monitors: Number(fields.monitor_packs ?? 0), fast_monitors: Number(fields.fast_packs ?? 0) });
    const tenant = await db
      .prepare("SELECT id FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
      .bind(session.account.id)
      .first<{ id: string }>();
    if (!tenant) return seeOther("/start");
    try {
      return await withBillingLock(db, session.account.id, c.get("now"), async () => {
        // One subscription per account: a second Checkout would bill twice.
        if (await decidingSubscription(db, session.account.id)) return back(c, "already-paid");
        const customer = await customerFor(c, setup, session);
        // One open Checkout Session per account: the last one is expired first, so
        // two tabs, or both plan buttons, can't leave two pages that each take a
        // payment. One that can't be expired was finished or expired already;
        // a finished one is caught by the webhook's duplicate check.
        const previous = await db.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(session.account.id).first<{ checkout_session_id: string | null }>();
        if (previous?.checkout_session_id) {
          await setup.stripe.expireCheckoutSession(previous.checkout_session_id).catch((error: unknown) => {
            if (!(error instanceof StripeApiError) || error.retryable) throw error;
          });
        }
        const { config } = setup;
        const items = [
          { price: config.priceHosted, quantity: 1 },
          ...(plan === "hosted_fast" ? [{ price: config.priceFast, quantity: 1 }] : []),
          ...(packs.monitors ? [{ price: config.priceMonitorPack, quantity: packs.monitors }] : []),
          ...(packs.fast_monitors ? [{ price: config.priceFastPack, quantity: packs.fast_monitors }] : []),
        ];
        const checkout = await setup.stripe.createCheckoutSession(
          {
            customer,
            items,
            successUrl: `${origin(c)}/billing?done=welcome`,
            cancelUrl: `${origin(c)}/billing`,
            accountId: session.account.id,
            metadata: { account_id: session.account.id, tenant_id: tenant.id, plan },
            automaticTax: setup.config.automaticTax,
          },
          `checkout-${session.account.id}-${crypto.randomUUID()}`,
        );
        await db.prepare("UPDATE accounts SET checkout_session_id = ? WHERE id = ?").bind(checkout.id, session.account.id).run();
        return continuePage({ href: checkout.url, title: "Going to Stripe", body: "Opening Stripe's secure checkout.", label: "Continue to checkout" });
      });
    } catch (error) {
      if (error instanceof BillingBusyError) return back(c, "busy", 409);
      if (!(error instanceof StripeApiError)) throw error;
      log.error("billing.checkout_failed", { account: session.account.id, status: error.status, errorCode: error.code, error: error.message });
      return back(c, "stripe-error", 502);
    }
  });

  app.post("/billing/portal", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther("/sign-in?next=%2Fbilling");
    const setup = deps.billing(c.env);
    if (!setup.ok) return seeOther("/billing");
    const row = await c.env.PLATFORM_DB.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(session.account.id).first<{ stripe_customer_id: string | null }>();
    if (!row?.stripe_customer_id) return back(c, "no-customer");
    try {
      const portal = await setup.stripe.createPortalSession({
        customer: row.stripe_customer_id,
        returnUrl: `${origin(c)}/billing`,
        configuration: setup.config.portalConfiguration ?? undefined,
      });
      return continuePage({ href: portal.url, title: "Going to Stripe", body: "Opening your billing on Stripe.", label: "Continue to billing" });
    } catch (error) {
      if (!(error instanceof StripeApiError)) throw error;
      log.error("billing.portal_failed", { account: session.account.id, status: error.status, errorCode: error.code, error: error.message });
      return back(c, "stripe-error", 502);
    }
  });

  /** The invoice a change waits on (declined card, a bank's confirmation), when Stripe left one. */
  function waitingInvoice(sub: StripeSubscription): string | null {
    const invoice = sub.pending_update && sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
    return invoice?.hosted_invoice_url ?? null;
  }

  /** The Stripe page to finish a payment a change waits on. */
  function finishPayment(href: string, what: string): Response {
    return continuePage({
      href,
      title: "Finish the payment",
      body: `Your card needs another step before ${what} can be added. Stripe's invoice page opens next; nothing changes until it is paid.`,
      label: "Pay on Stripe",
    });
  }

  /**
   * A change to a paid subscription (the add-on, a pack), holding the
   * account's billing lock, so two changes, or a change and a webhook
   * delivery, take turns; the webhook's 409 makes Stripe deliver again
   * later. Refused while an earlier change waits on its payment: Stripe
   * keeps one pending update at a time.
   */
  async function changeSubscription(
    c: Ctx,
    setup: Extract<BillingSetup, { ok: true }>,
    change: (sub: { id: string; plan: string; stripe: StripeSubscription }) => Promise<Response>,
  ): Promise<Response> {
    const session = c.get("session")!;
    const db = c.env.PLATFORM_DB;
    try {
      return await withBillingLock(db, session.account.id, c.get("now"), async () => {
        const row = await decidingSubscription(db, session.account.id);
        if (!row || (row.status !== "active" && row.status !== "trialing")) return back(c, "no-plan");
        // Stripe's subscription as it is now, not our copy: a change in flight shows here first.
        const current = await setup.stripe.retrieveSubscription(row.stripe_subscription_id, { expandInvoice: true });
        if (current.pending_update) return back(c, "change-pending");
        return change({ id: row.stripe_subscription_id, plan: row.plan, stripe: current });
      });
    } catch (error) {
      if (error instanceof BillingBusyError) return back(c, "busy", 409);
      if (!(error instanceof StripeApiError)) throw error;
      log.error("billing.change_failed", { account: session.account.id, status: error.status, errorCode: error.code, error: error.message });
      return back(c, error.status === 402 ? "card-declined" : "stripe-error", error.status === 402 ? 402 : 502);
    }
  }

  app.post("/billing/add-fast", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther("/sign-in?next=%2Fbilling%2Fupgrade");
    const setup = deps.billing(c.env);
    if (!setup.ok) return seeOther("/billing");
    return changeSubscription(c, setup, async (sub) => {
      if (sub.plan === "hosted_fast" || sub.stripe.items.data.some((i) => i.price.id === setup.config.priceFast)) return back(c, "already-fast");
      // A double tap within the same minute adds it once.
      const minute = Math.floor(c.get("now") / 60_000);
      await setup.stripe.addSubscriptionItem({ subscription: sub.id, price: setup.config.priceFast }, `add-fast-${sub.id}-${minute}`);
      // A declined card or a bank that wants the customer to confirm doesn't
      // fail the call: the change waits as a pending update on an open invoice
      // (https://docs.stripe.com/billing/subscriptions/pending-updates).
      const invoice = waitingInvoice(await setup.stripe.retrieveSubscription(sub.id, { expandInvoice: true }));
      if (invoice) return finishPayment(invoice, "1-minute checks");
      return back(c, "upgrading");
    });
  });

  /**
   * Sets how many of a pack the plan has: `kind` (monitors, fast_monitors)
   * and `quantity`, the new total (the page's buttons send one more or one
   * fewer than now), so a repeated post asks for the same total and changes
   * nothing twice. More is charged for the rest of the year at once and
   * applies once paid; fewer applies at once and credits the unused part to
   * the renewal (stripe.ts, CHARGE_NOW and CREDIT_LATER). The limits follow
   * the webhook, never this post.
   */
  app.post("/billing/packs", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther("/sign-in?next=%2Fbilling");
    const setup = deps.billing(c.env);
    if (!setup.ok) return seeOther("/billing");
    const fields = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const kind = oneOf<PackKind | "none">([...PACK_KINDS, "none"], fields.kind, "none");
    const target = Number(fields.quantity);
    if (kind === "none" || !Number.isSafeInteger(target) || target < 0) return back(c, "bad-pack", 400);
    if (target > PACKS[kind].max) return back(c, "packs-at-most");
    const price = kind === "monitors" ? setup.config.priceMonitorPack : setup.config.priceFastPack;
    return changeSubscription(c, setup, async (sub) => {
      if (!PACKS[kind].plans.includes(sub.plan as PlanId)) return back(c, "needs-fast");
      const items = sub.stripe.items.data.filter((i) => i.price.id === price);
      const now = items.reduce((n, i) => n + (i.quantity ?? 1), 0);
      if (target === now) return back(c, "packs-unchanged");
      // One line per price; anything else (two lines of one price, made in Stripe's dashboard) is the owner's to sort out.
      const [item, ...extra] = items;
      if (extra.length) {
        log.warn("billing.packs_split", { account: session.account.id, subscription: sub.id, price });
        return back(c, "stripe-error", 409);
      }
      // A double tap within the same minute, asking for the same total from the same one, changes it once.
      const key = `packs-${sub.id}-${kind}-${now}-${target}-${Math.floor(c.get("now") / 60_000)}`;
      const increase = target > now;
      if (!item) await setup.stripe.addSubscriptionItem({ subscription: sub.id, price, quantity: target }, key);
      else if (target === 0) await setup.stripe.deleteSubscriptionItem(item.id, key);
      else await setup.stripe.updateSubscriptionItem({ item: item.id, quantity: target, increase }, key);
      if (increase) {
        const invoice = waitingInvoice(await setup.stripe.retrieveSubscription(sub.id, { expandInvoice: true }));
        if (invoice) return finishPayment(invoice, kind === "monitors" ? "extra monitors" : "extra fast monitors");
      }
      return back(c, increase ? "packs-added" : "packs-removed");
    });
  });
}
