/**
 * POST /stripe/webhook on app.<domain>: Stripe's events, signed.
 *
 * In order:
 *   1. the signature (./signature.ts), on the raw body, before anything is
 *      parsed; anything unsigned or stale is a 400 and changes nothing;
 *   2. test mode: an event whose `livemode` doesn't match STRIPE_MODE is
 *      refused (400), so a live event can't reach a test platform;
 *   3. once per event id (stripe_events): a redelivery of a processed event
 *      answers 200 at once; one being processed right now by another
 *      delivery answers 409, and Stripe delivers it again later;
 *   4. the event names a subscription and its account, and the account's
 *      billing lock (./lock.ts) is taken: a second delivery for the same
 *      account meanwhile answers 409 and comes again later;
 *   5. the subscription is fetched from Stripe while holding the lock:
 *      events can arrive in any order, so the current object, not the
 *      event's copy, decides (Stripe's own advice, "Event ordering" in
 *      https://docs.stripe.com/webhooks); it is fetched again after saving
 *      until two reads agree, and every write checks the lock is still held;
 *   6. ./state.ts brings the tenant to it (the plan, and the packs from the
 *      items' quantities, held to their caps); a second paid subscription for an
 *      account is cancelled and refunded; a failed payment emails the
 *      customer once per invoice and attempt (dunning), unless a later
 *      payment already went through.
 * A failure in 4 or 5 answers 500 and leaves the event unprocessed, so
 * Stripe's retry runs it again; applying a fetched subscription twice
 * changes nothing.
 *
 * Events this endpoint needs (the owner subscribes the endpoint to these):
 * checkout.session.completed, customer.subscription.created,
 * customer.subscription.updated, customer.subscription.deleted,
 * customer.subscription.paused, customer.subscription.resumed,
 * customer.subscription.pending_update_applied,
 * customer.subscription.pending_update_expired, invoice.paid,
 * invoice.payment_failed. Any other type is acknowledged and ignored.
 */

import { getAccount } from "../accounts";
import type { Mailer } from "../mail";
import type { BillingSetup } from "./config";
import { verifyStripeSignature } from "./signature";
import { BillingBusyError, HOLDS, holdsBinds, withBillingLock, type BillingLock } from "./lock";
import {
  PENDING_TEXT,
  applyAccountBilling,
  packsForItems,
  pendingItemsOf,
  pendingText,
  planForPrices,
  savedPlan,
  saveSubscription,
  type BillingChange,
} from "./state";
import type { StripeApi, StripeSubscription } from "./stripe";
import { log } from "../log";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** Stripe's events are a few KB; anything far bigger isn't one. */
const MAX_BODY_BYTES = 512 * 1024;
/** One delivery holds an event this long while it works on it. */
const PROCESSING_MS = 60_000;

export interface WebhookDeps {
  db: D1Database;
  setup: BillingSetup;
  mailer: Mailer | null;
  /** https://app.<domain>, for the links in emails. */
  appOrigin: string;
  now: number;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function isEvent(value: unknown): value is StripeEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  return (
    typeof e.id === "string" &&
    /^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) &&
    typeof e.type === "string" &&
    e.type.length <= 100 &&
    Number.isSafeInteger(e.created) &&
    typeof e.livemode === "boolean" &&
    !!data &&
    typeof data.object === "object" &&
    data.object !== null
  );
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 255 ? v : null);

/** The subscription an event is about, by Stripe's id, or null when it is about none. */
export function subscriptionOf(event: StripeEvent): string | null {
  const o = event.data.object;
  if (event.type === "checkout.session.completed") return o.mode === "subscription" ? str(o.subscription) : null;
  if (event.type.startsWith("customer.subscription.")) return str(o.id);
  if (event.type.startsWith("invoice.")) {
    // Since the 2025 "basil" release an invoice names its subscription under parent.
    const parent = o.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    return str(parent?.subscription_details?.subscription);
  }
  return null;
}

export async function handleStripeWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.setup.ok) {
    log.warn("billing.webhook_while_off", { missing: deps.setup.missing });
    return json({ error: "billing_off" }, 503);
  }
  const { config } = deps.setup;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);

  const signature = await verifyStripeSignature({ body, header: request.headers.get("stripe-signature"), secret: config.webhookSecret, now: deps.now });
  if (!signature.ok) {
    log.warn("billing.webhook_refused", { reason: signature.reason });
    return json({ error: "bad_signature" }, 400);
  }
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "bad_payload" }, 400);
  }
  if (!isEvent(event)) return json({ error: "bad_payload" }, 400);
  if (event.livemode !== config.live) {
    log.error("billing.webhook_wrong_mode", { stripeEvent: event.id, livemode: event.livemode });
    return json({ error: "wrong_mode" }, 400);
  }

  // Take the event: a new one, or one whose earlier delivery failed or died.
  const taken = await deps.db
    .prepare(
      `INSERT INTO stripe_events (id, type, created, received_at, processing_until) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET processing_until = excluded.processing_until
       WHERE stripe_events.processed_at IS NULL AND (stripe_events.processing_until IS NULL OR stripe_events.processing_until <= ?4)`,
    )
    .bind(event.id, event.type, event.created, deps.now, deps.now + PROCESSING_MS)
    .run();
  if ((taken.meta.changes ?? 0) === 0) {
    const row = await deps.db.prepare("SELECT processed_at FROM stripe_events WHERE id = ?").bind(event.id).first<{ processed_at: number | null }>();
    if (row?.processed_at) return json({ received: true, duplicate: true });
    return json({ error: "in_progress" }, 409);
  }

  try {
    await processEvent(event, deps);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await deps.db.prepare("UPDATE stripe_events SET processing_until = NULL, error = ? WHERE id = ?").bind(message, event.id).run();
    // Another delivery holds the account: Stripe delivers this one again later.
    if (error instanceof BillingBusyError) return json({ error: "in_progress" }, 409);
    log.error("billing.webhook_failed", { stripeEvent: event.id, type: event.type, error: message });
    return json({ error: "failed" }, 500);
  }
  await deps.db.prepare("UPDATE stripe_events SET processed_at = ?, processing_until = NULL, error = NULL WHERE id = ?").bind(deps.now, event.id).run();
  log.info("billing.webhook_processed", { stripeEvent: event.id, type: event.type });
  return json({ received: true });
}

/** Which account an event is for, from the event itself, or from the subscription when the event doesn't say. */
async function accountOf(event: StripeEvent, subscriptionId: string, deps: WebhookDeps & { stripe: StripeApi }): Promise<string | null> {
  const db = deps.db;
  const o = event.data.object;
  let customer = str(o.customer);
  let metaAccount = str((o.metadata as Record<string, unknown> | undefined)?.account_id) ?? str(o.client_reference_id);
  if (!customer) {
    const sub = await deps.stripe.retrieveSubscription(subscriptionId);
    customer = sub.customer;
    metaAccount = str(sub.metadata?.account_id);
  }
  const byCustomer = await db.prepare("SELECT id FROM accounts WHERE stripe_customer_id = ?").bind(customer).first<{ id: string }>();
  if (byCustomer) return byCustomer.id;
  // A Checkout that raced the account's first save: the account id billing
  // put in the metadata, which came back from Stripe, signed.
  const found = metaAccount ? await getAccount(db, metaAccount) : null;
  if (!found) return null;
  await db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customer, found.id).run();
  return found.id;
}

/** Recorded for the owner (the admin console's audit log, action prefix "billing."): something billing couldn't place. */
async function needsAttention(db: D1Database, accountId: string | null, detail: Record<string, string | number | null>, now: number): Promise<void> {
  log.warn("billing.needs_attention", { account: accountId, ...detail });
  const tenant = accountId
    ? await db.prepare("SELECT id FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1").bind(accountId).first<{ id: string }>()
    : null;
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', 'billing.needs_attention', ?)")
    .bind(now, accountId, tenant?.id ?? null, JSON.stringify(detail))
    .run();
}

const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

function stateKey(sub: StripeSubscription): string {
  return JSON.stringify([
    sub.status,
    sub.cancel_at_period_end,
    sub.items.data.map((i) => `${i.price.id}x${i.quantity ?? 1}`).sort(),
    sub.pending_update?.expires_at ?? null,
  ]);
}

async function processEvent(event: StripeEvent, deps: WebhookDeps): Promise<void> {
  if (!deps.setup.ok) return;
  const { stripe } = deps.setup;
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.type)) return;
  const subscriptionId = subscriptionOf(event);
  if (!subscriptionId) return;
  const accountId = await accountOf(event, subscriptionId, { ...deps, stripe });
  if (!accountId) {
    await needsAttention(deps.db, null, { reason: "unknown_account", subscription: subscriptionId, event: event.type }, deps.now);
    return;
  }
  await withBillingLock(deps.db, accountId, deps.now, async (lock) => {
    // Fetched while holding the account, then fetched again after saving until
    // two reads agree, so what is saved last is what Stripe says now.
    let sub = await stripe.retrieveSubscription(subscriptionId, { expandInvoice: true });
    let change: BillingChange | null = null;
    for (let round = 0; round < 3; round++) {
      change = (await applySubscription(deps, lock, sub, event)) ?? change;
      const again = await stripe.retrieveSubscription(subscriptionId, { expandInvoice: true });
      if (stateKey(again) === stateKey(sub)) break;
      sub = again;
    }
    if (event.type === "checkout.session.completed") {
      await deps.db.prepare("UPDATE accounts SET checkout_session_id = NULL WHERE id = ? AND checkout_session_id = ?").bind(accountId, str(event.data.object.id)).run();
    }
    if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") await recordInvoice(deps, lock, sub, event, change);
  });
}

/**
 * Saves one fetched subscription and brings the tenant to it. A second
 * subscription that becomes active while the account already pays for one
 * (two Checkouts finished) is cancelled and refunded at once: the first one
 * kept wins, since the lock makes them take turns.
 */
async function applySubscription(deps: WebhookDeps, lock: BillingLock, fetched: StripeSubscription, event: StripeEvent): Promise<BillingChange | null> {
  if (!deps.setup.ok) return null;
  const { config } = deps.setup;
  const db = deps.db;
  let sub = fetched;
  let plan = planForPrices(
    sub.items.data.map((i) => i.price.id),
    config,
  );
  if (!plan) {
    // Not our prices (a price changed in the dashboard, a portal setting): the owner must look,
    // and a subscription we already know keeps its plan so a cancellation still stops checks.
    plan = await savedPlan(db, sub.id);
    await needsAttention(db, lock.accountId, { reason: "unknown_prices", subscription: sub.id, status: sub.status, event: event.type }, deps.now);
    if (!plan) return null;
  }
  // An account being deleted (src/account-deletion.ts) can't start paying
  // again: a Checkout finished from a page left open is cancelled and refunded.
  const deleting = ACTIVE_STATUSES.includes(sub.status)
    ? await db.prepare("SELECT 1 AS x FROM accounts WHERE id = ? AND deletion_requested_at IS NOT NULL").bind(lock.accountId).first()
    : null;
  if (deleting) {
    sub = await refundForDeletedAccount(deps, lock, sub);
  } else if (ACTIVE_STATUSES.includes(sub.status)) {
    const other = await db
      .prepare(
        `SELECT stripe_subscription_id FROM subscriptions WHERE account_id = ? AND stripe_subscription_id <> ? AND status IN ('active', 'trialing', 'past_due') LIMIT 1`,
      )
      .bind(lock.accountId, sub.id)
      .first<{ stripe_subscription_id: string }>();
    if (other) sub = await refundDuplicate(deps, lock, sub, other.stripe_subscription_id);
  }
  const tenant = await db
    .prepare("SELECT id FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
    .bind(lock.accountId)
    .first<{ id: string }>();
  // Packs from the items' quantities. Over a cap, or fast packs without the
  // add-on (a change made in Stripe's dashboard), count as the cap or none,
  // and the owner is told so they can put the subscription right.
  const { packs, problems } = packsForItems(sub.items.data, plan, config);
  if (problems.length) {
    await needsAttention(db, lock.accountId, { reason: "packs", problems: problems.join(" "), subscription: sub.id, event: event.type }, deps.now);
  }
  await saveSubscription(db, lock, { sub, tenantId: tenant?.id ?? null, plan, packs, config, now: deps.now });
  const change = await applyAccountBilling(db, lock, deps.now);
  if (change) log.info("billing.tenant_changed", { tenant: change.tenantId, from: change.from, to: change.to });
  return change;
}

/** Cancels `sub` now and refunds every payment of its latest invoice in full; idempotent under `key`. */
async function cancelAndRefund(stripe: StripeApi, sub: StripeSubscription, key: string): Promise<{ canceled: StripeSubscription; refunded: number }> {
  const canceled = await stripe.cancelSubscription(sub.id, `${key}-cancel-${sub.id}`);
  const invoice = typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
  let refunded = 0;
  if (invoice) {
    const payments = await stripe.listInvoicePayments(invoice);
    for (const p of payments.data) {
      if (p.payment.type !== "payment_intent" || !p.payment.payment_intent) continue;
      await stripe.createRefund({ paymentIntent: p.payment.payment_intent, reason: "duplicate" }, `${key}-refund-${p.payment.payment_intent}`);
      refunded++;
    }
  }
  return { canceled, refunded };
}

/** A subscription that became active on an account being deleted: cancelled and refunded at once, and audited. */
async function refundForDeletedAccount(deps: WebhookDeps, lock: BillingLock, sub: StripeSubscription): Promise<StripeSubscription> {
  if (!deps.setup.ok) return sub;
  log.warn("billing.subscription_on_deleted_account", { account: lock.accountId, subscription: sub.id });
  const { canceled, refunded } = await cancelAndRefund(deps.setup.stripe, sub, "deleted-account");
  await deps.db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, NULL, 'system', 'billing.deleted_account_refunded', ?)")
    .bind(deps.now, lock.accountId, JSON.stringify({ subscription: sub.id, refunds: refunded }))
    .run();
  return { ...canceled, latest_invoice: sub.latest_invoice ?? null };
}

/** Cancels a second paid subscription, refunds what it took, and tells the customer. */
async function refundDuplicate(deps: WebhookDeps, lock: BillingLock, sub: StripeSubscription, kept: string): Promise<StripeSubscription> {
  if (!deps.setup.ok) return sub;
  log.warn("billing.duplicate_subscription", { account: lock.accountId, duplicate: sub.id, kept });
  const { canceled, refunded } = await cancelAndRefund(deps.setup.stripe, sub, "duplicate");
  await deps.db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, NULL, 'system', 'billing.duplicate_refunded', ?)")
    .bind(deps.now, lock.accountId, JSON.stringify({ duplicate: sub.id, kept, refunds: refunded }))
    .run();
  await sendOnce(deps, `duplicate:${sub.id}`, lock.accountId, (account) => ({
    subject: "We refunded a second OpenPing Hosted payment",
    lines: [
      "Your account was charged twice for OpenPing Hosted, probably from two checkout pages open at once.",
      "We cancelled the second subscription and refunded its payment in full; it can take 5 to 10 days to reach your card.",
      `Your plan is unchanged. Your billing: ${deps.appOrigin}/billing`,
      `Signed in as ${account.email}.`,
    ],
  }));
  return { ...canceled, latest_invoice: sub.latest_invoice ?? null };
}

/**
 * Dunning bookkeeping, in the order the invoices happened rather than the
 * order the events arrived: a failure is recorded (and emailed, once per
 * invoice and attempt) only when no later payment went through.
 */
async function recordInvoice(deps: WebhookDeps, lock: BillingLock, sub: StripeSubscription, event: StripeEvent, change: BillingChange | null): Promise<void> {
  const at = event.created * 1000;
  const o = event.data.object;
  if (event.type === "invoice.paid") {
    await deps.db
      .prepare(
        `UPDATE subscriptions SET last_paid_at = MAX(COALESCE(last_paid_at, 0), ?1),
           payment_failed_at = CASE WHEN payment_failed_at <= ?1 THEN NULL ELSE payment_failed_at END,
           next_payment_attempt = CASE WHEN payment_failed_at <= ?1 THEN NULL ELSE next_payment_attempt END
         WHERE stripe_subscription_id = ?2 AND ${HOLDS}`,
      )
      .bind(at, sub.id, ...holdsBinds(lock))
      .run();
    return;
  }
  const next = Number.isSafeInteger(o.next_payment_attempt) ? (o.next_payment_attempt as number) * 1000 : null;
  const recorded = await deps.db
    .prepare(
      `UPDATE subscriptions SET payment_failed_at = ?1, next_payment_attempt = ?2
       WHERE stripe_subscription_id = ?3 AND COALESCE(last_paid_at, 0) < ?1 AND ${HOLDS}`,
    )
    .bind(at, next, sub.id, ...holdsBinds(lock))
    .run();
  if ((recorded.meta.changes ?? 0) === 0) return; // a later payment already went through
  const invoiceId = str(o.id) ?? "unknown";
  const attempt = Number.isSafeInteger(o.attempt_count) ? (o.attempt_count as number) : 0;
  // An add-on whose payment failed (a pending update): the plan didn't change, and the link is the invoice to pay.
  const forUpdate = o.billing_reason === "subscription_update" && !!sub.pending_update;
  const payUrl = str(o.hosted_invoice_url) ?? `${deps.appOrigin}/billing`;
  const when = next ? new Date(next).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
  const paused = change?.to.status === "suspended";
  // What the waiting change would add: "1-minute checks", "extra monitors", "extra fast monitors".
  const what = deps.setup.ok ? pendingText(pendingItemsOf(sub, deps.setup.config) ?? []) : PENDING_TEXT.fast;
  await sendOnce(deps, `payment_failed:${invoiceId}:${attempt}`, lock.accountId, () => ({
    subject: forUpdate ? `Your ${what} weren't added: the payment didn't go through` : "Your OpenPing Hosted payment didn't go through",
    lines: forUpdate
      ? [
          `We couldn't take the payment for ${what}, so they weren't added. Your plan and your checks are unchanged.`,
          `To add them, pay the invoice within a day: ${payUrl}`,
          `Or try again later from ${deps.appOrigin}/billing.`,
        ]
      : [
          "We couldn't take the payment for your OpenPing Hosted plan.",
          paused
            ? "Your OpenPing's checks are paused until it is paid. Your monitors and history are kept."
            : when
              ? `Stripe will try your card again on ${when}. Your checks keep running in the meantime.`
              : "Your checks keep running while you sort it out.",
          `Update your card or pay the invoice here: ${deps.appOrigin}/billing`,
          "If Stripe's last try fails, the subscription is cancelled and your checks stop; you can subscribe again from the same page.",
        ],
  }));
}

/** Sends a billing email at most once per `key` (billing_emails), even when the event is delivered again. */
async function sendOnce(
  deps: WebhookDeps,
  key: string,
  accountId: string,
  build: (account: { email: string }) => { subject: string; lines: string[] },
): Promise<void> {
  if (!deps.mailer) {
    log.warn("billing.email_no_mailer", { account: accountId, emailKey: key });
    return;
  }
  const account = await getAccount(deps.db, accountId);
  if (!account) return;
  const claimed = await deps.db.prepare("INSERT INTO billing_emails (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, deps.now).run();
  if ((claimed.meta.changes ?? 0) === 0) return;
  const { subject, lines } = build(account);
  const link = (l: string) => l.replace(/(https?:\/\/\S+?)(\.?)$/, (_m, url: string, dot: string) => `<a href="${url}">${url}</a>${dot}`);
  const sent = await deps.mailer.send({
    to: account.email,
    subject,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${link(l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</p>`).join(""),
  });
  if (!sent.ok) log.error("billing.email_not_sent", { account: accountId, emailKey: key, error: sent.error });
}

/** Stripe's events and the billing emails, kept this long (from the cron, through their indexes). */
export const BILLING_RECORDS_DAYS = 90;
export const OLD_EVENTS_SQL = "DELETE FROM stripe_events INDEXED BY idx_stripe_events_received WHERE received_at < ?";
export const OLD_EMAILS_SQL = "DELETE FROM billing_emails INDEXED BY idx_billing_emails_sent WHERE sent_at < ?";

export function billingRecordsCleanup(db: D1Database, now: number): D1PreparedStatement[] {
  const before = now - BILLING_RECORDS_DAYS * 86_400_000;
  return [db.prepare(OLD_EVENTS_SQL).bind(before), db.prepare(OLD_EMAILS_SQL).bind(before)];
}
