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
 *   4. the event names a subscription, and the subscription is fetched from
 *      Stripe: events can arrive in any order, so the current object, not
 *      the event's copy, decides (Stripe's own advice, "Event ordering" in
 *      https://docs.stripe.com/webhooks);
 *   5. ./state.ts brings the tenant to it; a failed payment also emails the
 *      customer (dunning), after the state is saved.
 * A failure in 4 or 5 answers 500 and leaves the event unprocessed, so
 * Stripe's retry runs it again; applying a fetched subscription twice
 * changes nothing.
 *
 * Events this endpoint needs (the owner subscribes the endpoint to these):
 * checkout.session.completed, customer.subscription.created,
 * customer.subscription.updated, customer.subscription.deleted,
 * customer.subscription.paused, customer.subscription.resumed, invoice.paid,
 * invoice.payment_failed. Any other type is acknowledged and ignored.
 */

import { getAccount } from "../accounts";
import type { Mailer } from "../mail";
import type { BillingSetup } from "./config";
import { verifyStripeSignature } from "./signature";
import { applyAccountBilling, planForPrices, saveSubscription, type BillingChange } from "./state";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
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
    console.warn("[billing] webhook received while billing is off:", deps.setup.missing.join(", "));
    return json({ error: "billing_off" }, 503);
  }
  const { config } = deps.setup;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);

  const signature = await verifyStripeSignature({ body, header: request.headers.get("stripe-signature"), secret: config.webhookSecret, now: deps.now });
  if (!signature.ok) {
    console.warn("[billing] webhook refused", { reason: signature.reason });
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
    console.error("[billing] event from the wrong mode refused", { id: event.id, livemode: event.livemode });
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
    console.error("[billing] event failed; Stripe will deliver it again", { id: event.id, type: event.type, error: message });
    await deps.db.prepare("UPDATE stripe_events SET processing_until = NULL, error = ? WHERE id = ?").bind(message, event.id).run();
    return json({ error: "failed" }, 500);
  }
  await deps.db.prepare("UPDATE stripe_events SET processed_at = ?, processing_until = NULL, error = NULL WHERE id = ?").bind(deps.now, event.id).run();
  return json({ received: true });
}

async function processEvent(event: StripeEvent, deps: WebhookDeps): Promise<void> {
  if (!deps.setup.ok) return;
  const { stripe, config } = deps.setup;
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.type)) return;
  const subscriptionId = subscriptionOf(event);
  if (!subscriptionId) return;

  const sub = await stripe.retrieveSubscription(subscriptionId);
  const db = deps.db;
  // Whose it is: the Customer billing made for the account, or, for a
  // Checkout that raced the customer's first save, the account id billing
  // put in the subscription's metadata. Both came from Stripe, signed.
  let account = await db.prepare("SELECT id FROM accounts WHERE stripe_customer_id = ?").bind(sub.customer).first<{ id: string }>();
  if (!account) {
    const metaAccount = str(sub.metadata?.account_id);
    const found = metaAccount ? await getAccount(db, metaAccount) : null;
    if (!found) {
      console.warn("[billing] a subscription for no account here, ignored", { subscription: sub.id });
      return;
    }
    await db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(sub.customer, found.id).run();
    account = { id: found.id };
  }
  const plan = planForPrices(
    sub.items.data.map((i) => i.price.id),
    config,
  );
  if (!plan) {
    console.warn("[billing] a subscription to other prices, ignored", { subscription: sub.id });
    return;
  }
  const tenant = await db
    .prepare("SELECT id FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1")
    .bind(account.id)
    .first<{ id: string }>();
  await saveSubscription(db, { sub, accountId: account.id, tenantId: tenant?.id ?? null, plan, now: deps.now });

  if (event.type === "invoice.payment_failed") {
    const next = event.data.object.next_payment_attempt;
    await db
      .prepare("UPDATE subscriptions SET payment_failed_at = ?, next_payment_attempt = ? WHERE stripe_subscription_id = ?")
      .bind(deps.now, Number.isSafeInteger(next) ? (next as number) * 1000 : null, sub.id)
      .run();
  } else if (event.type === "invoice.paid") {
    await db.prepare("UPDATE subscriptions SET payment_failed_at = NULL, next_payment_attempt = NULL WHERE stripe_subscription_id = ?").bind(sub.id).run();
  }

  const change = await applyAccountBilling(db, account.id, deps.now);
  if (change) console.log("[billing] tenant billing changed", { tenant: change.tenantId, from: change.from, to: change.to });
  if (event.type === "invoice.payment_failed") await sendPaymentFailed(deps, account.id, event, change);
}

/** Dunning: tell the customer at once, with the way to fix it. Stripe retries the payment on its own schedule. */
async function sendPaymentFailed(deps: WebhookDeps, accountId: string, event: StripeEvent, change: BillingChange | null): Promise<void> {
  if (!deps.mailer) {
    console.warn("[billing] payment failed, and no mailer to tell the customer", { account: accountId });
    return;
  }
  const account = await getAccount(deps.db, accountId);
  if (!account) return;
  const next = event.data.object.next_payment_attempt;
  const when = Number.isSafeInteger(next)
    ? new Date((next as number) * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  const link = `${deps.appOrigin}/billing`;
  const paused = change?.to.status === "suspended";
  const lines = [
    "We couldn't take the payment for your OpenPing Hosted plan.",
    paused
      ? "Your OpenPing's checks are paused until it is paid. Your monitors and history are kept."
      : when
        ? `Stripe will try your card again on ${when}. Your checks keep running in the meantime.`
        : "Your checks keep running while you sort it out.",
    `Update your card or pay the invoice here: ${link}`,
    "If you didn't mean to keep the plan, you can cancel from the same page.",
  ];
  const sent = await deps.mailer.send({
    to: account.email,
    subject: "Your OpenPing Hosted payment didn't go through",
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${l.replace(link, `<a href="${link}">${link}</a>`)}</p>`).join(""),
  });
  if (!sent.ok) console.error("[billing] payment-failed email not sent", { account: accountId, error: sent.error });
}
