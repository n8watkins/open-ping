/**
 * The customer's billing routes on app.<domain>, inside the account routes
 * (so the session and the same-origin check on every post apply):
 *
 *   GET  /billing           the plan, renewal, and what can be done
 *   GET  /billing/upgrade   the same, leading with the next plan up (the tenant's 402 answers link here)
 *   POST /billing/checkout  Stripe Checkout for the yearly plan, with or without 1-minute checks
 *   POST /billing/portal    Stripe's Customer Portal: card, invoices, cancel
 *   POST /billing/add-fast  adds 1-minute checks to a paid plan
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
import { BILLING_REASONS, type BillingReason } from "./state";
import { BillingBusyError, withBillingLock } from "./lock";
import { StripeApiError } from "./stripe";
import { PLAN_IDS, TENANT_STATUSES, type PlanId, type TenantStatus } from "../../../src/shared/hosted-contract";
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

/** Everything the billing section shows for an account: three reads, one round trip. */
export async function billingView(db: D1Database, accountId: string, available: boolean, now: number): Promise<BillingView> {
  const [tenantRows, subRows, accountRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT status, plan, billing_reason, trial_ends_at FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
      .bind(accountId),
    db
      .prepare(
        `SELECT status, current_period_end, cancel_at_period_end, ended_at, payment_failed_at, next_payment_attempt, pending_until, pending_invoice_url FROM subscriptions
         WHERE account_id = ? ORDER BY CASE status WHEN 'active' THEN 6 WHEN 'trialing' THEN 6 WHEN 'past_due' THEN 5 WHEN 'unpaid' THEN 4
           WHEN 'paused' THEN 3 WHEN 'canceled' THEN 2 ELSE 0 END DESC, updated_at DESC LIMIT 1`,
      )
      .bind(accountId),
    db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(accountId),
  ]);
  const t = tenantRows!.results[0] as { status: string; plan: string; billing_reason: string | null; trial_ends_at: number | null } | undefined;
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
      }
    | undefined;
  const a = accountRows!.results[0] as { stripe_customer_id: string | null } | undefined;
  return {
    available,
    hasTenant: !!t,
    status: oneOf<TenantStatus>(TENANT_STATUSES, t?.status, "trial"),
    plan: oneOf<PlanId>(PLAN_IDS, t?.plan, "trial"),
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
          pending: s.pending_until && s.pending_until > now && s.pending_invoice_url ? { until: s.pending_until, invoiceUrl: s.pending_invoice_url } : null,
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
      return billingPage({ view, now: c.get("now"), focus, flash: FLASH[c.req.query("done") ?? ""] ?? null });
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
        const prices = plan === "hosted_fast" ? [setup.config.priceHosted, setup.config.priceFast] : [setup.config.priceHosted];
        const checkout = await setup.stripe.createCheckoutSession(
          {
            customer,
            prices,
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

  app.post("/billing/add-fast", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther("/sign-in?next=%2Fbilling%2Fupgrade");
    const setup = deps.billing(c.env);
    if (!setup.ok) return seeOther("/billing");
    const sub = await decidingSubscription(c.env.PLATFORM_DB, session.account.id);
    if (!sub || (sub.status !== "active" && sub.status !== "trialing")) return back(c, "no-plan");
    if (sub.plan === "hosted_fast") return back(c, "already-fast");
    try {
      // A double tap within the same minute adds it once.
      const minute = Math.floor(c.get("now") / 60_000);
      await setup.stripe.addSubscriptionItem({ subscription: sub.stripe_subscription_id, price: setup.config.priceFast }, `add-fast-${sub.stripe_subscription_id}-${minute}`);
      // A declined card or a bank that wants the customer to confirm doesn't
      // fail the call: the change waits as a pending update on an open invoice
      // (https://docs.stripe.com/billing/subscriptions/pending-updates).
      const after = await setup.stripe.retrieveSubscription(sub.stripe_subscription_id, { expandInvoice: true });
      const invoice = after.pending_update && after.latest_invoice && typeof after.latest_invoice === "object" ? after.latest_invoice : null;
      if (invoice?.hosted_invoice_url) {
        return continuePage({
          href: invoice.hosted_invoice_url,
          title: "Finish the payment",
          body: "Your card needs another step before 1-minute checks can be added. Stripe's invoice page opens next; nothing changes until it is paid.",
          label: "Pay on Stripe",
        });
      }
    } catch (error) {
      if (!(error instanceof StripeApiError)) throw error;
      log.error("billing.addon_failed", { account: session.account.id, status: error.status, errorCode: error.code, error: error.message });
      return back(c, error.status === 402 ? "card-declined" : "stripe-error", error.status === 402 ? 402 : 502);
    }
    return back(c, "upgrading");
  });
}
