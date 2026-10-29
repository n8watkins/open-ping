/**
 * An in-memory Stripe: the StripeApi billing calls (customers, Checkout,
 * the portal, subscriptions, subscription items), plus what Stripe itself
 * does afterwards (a customer finishing Checkout, a renewal failing, the
 * retries running out, a cancellation), each producing the events Stripe
 * would send, in the shapes of the pinned API version. `signed()` turns an
 * event into the webhook request Stripe would make, with a real signature.
 * Nothing here touches the network.
 */

import { signStripePayload } from "../src/billing/signature";
import type { CheckoutInput, StripeApi, StripeInvoice, StripeSubscription, SubscriptionStatus } from "../src/billing/stripe";
import { StripeApiError } from "../src/billing/stripe";

export interface FakeEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  livemode: boolean;
  api_version: string;
  data: { object: Record<string, unknown> };
}

type Method =
  | "createCustomer"
  | "createCheckoutSession"
  | "createPortalSession"
  | "retrieveSubscription"
  | "addSubscriptionItem"
  | "expireCheckoutSession"
  | "cancelSubscription"
  | "listInvoicePayments"
  | "createRefund";

interface FakeInvoice extends StripeInvoice {
  subscription: string;
  payment_intent: string | null;
  attempt_count: number;
}

export class FakeStripe implements StripeApi {
  readonly customers = new Map<string, { id: string; email: string; metadata: Record<string, string> }>();
  readonly sessions = new Map<string, { id: string; url: string; input: CheckoutInput; status: "open" | "complete" | "expired" }>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly refunds: { paymentIntent: string; reason: string }[] = [];
  /** The next addSubscriptionItem's payment fails: the change waits as a pending update (Stripe's pending_if_incomplete). */
  declineNextUpdate = false;
  /** Runs inside retrieveSubscription after the copy is taken, so a test can stall a reader holding a stale copy. */
  onRetrieve: (() => Promise<void>) | null = null;
  readonly subscriptions = new Map<string, StripeSubscription>();
  readonly portals: { customer: string; returnUrl: string; configuration?: string }[] = [];
  readonly calls: { method: Method; idempotencyKey?: string }[] = [];
  private readonly idempotent = new Map<string, unknown>();
  private readonly failures = new Map<Method, StripeApiError>();
  private seq = 0;
  /** Ids are unique across instances, as Stripe's are: tests share one database. */
  private readonly prefix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  /** Stripe's clock, in seconds. */
  clock = Math.floor(Date.UTC(2026, 10, 2) / 1000);

  constructor(readonly webhookSecret = "whsec_test_fake_stripe_not_a_secret") {}

  private id(prefix: string) {
    return `${prefix}_fake${this.prefix}${(++this.seq).toString().padStart(4, "0")}`;
  }

  /** The next call of `method` fails like Stripe would. */
  failNext(method: Method, status = 500, code: string | null = null) {
    this.failures.set(method, new StripeApiError(status, "api_error", code, `fake Stripe ${method} failed`));
  }

  private enter(method: Method, idempotencyKey?: string) {
    this.calls.push({ method, idempotencyKey });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  private once<T>(key: string | undefined, make: () => T): T {
    if (!key) return make();
    if (this.idempotent.has(key)) return this.idempotent.get(key) as T;
    const value = make();
    this.idempotent.set(key, value);
    return value;
  }

  async createCustomer(input: { email: string; accountId: string }, idempotencyKey: string) {
    this.enter("createCustomer", idempotencyKey);
    return this.once(`customer:${idempotencyKey}`, () => {
      const customer = { id: this.id("cus"), email: input.email, metadata: { account_id: input.accountId } };
      this.customers.set(customer.id, customer);
      return { id: customer.id };
    });
  }

  async createCheckoutSession(input: CheckoutInput, idempotencyKey: string) {
    this.enter("createCheckoutSession", idempotencyKey);
    if (!this.customers.has(input.customer)) throw new StripeApiError(400, "invalid_request_error", "resource_missing", "No such customer");
    return this.once(`checkout:${idempotencyKey}`, () => {
      const id = this.id("cs_test");
      const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, input, status: "open" as const };
      this.sessions.set(id, session);
      return { id, url: session.url };
    });
  }

  async createPortalSession(input: { customer: string; returnUrl: string; configuration?: string }) {
    this.enter("createPortalSession");
    if (!this.customers.has(input.customer)) throw new StripeApiError(400, "invalid_request_error", "resource_missing", "No such customer");
    this.portals.push(input);
    return { url: `https://billing.stripe.com/p/session/test_${this.portals.length}` };
  }

  async retrieveSubscription(id: string, options: { expandInvoice?: boolean } = {}): Promise<StripeSubscription> {
    this.enter("retrieveSubscription");
    const sub = this.subscriptions.get(id);
    if (!sub) throw new StripeApiError(404, "invalid_request_error", "resource_missing", `No such subscription: '${id}'`);
    const copy = structuredClone(sub);
    if (options.expandInvoice && typeof copy.latest_invoice === "string") {
      const inv = this.invoices.get(copy.latest_invoice);
      if (inv) copy.latest_invoice = { id: inv.id, status: inv.status, billing_reason: inv.billing_reason, hosted_invoice_url: inv.hosted_invoice_url };
    }
    if (this.onRetrieve) await this.onRetrieve();
    return copy;
  }

  async expireCheckoutSession(id: string) {
    this.enter("expireCheckoutSession");
    const session = this.sessions.get(id);
    if (!session) throw new StripeApiError(404, "invalid_request_error", "resource_missing", "No such checkout session");
    if (session.status !== "open") throw new StripeApiError(400, "invalid_request_error", null, `Session is ${session.status} and can't be expired`);
    session.status = "expired";
    return { id, status: "expired" };
  }

  async cancelSubscription(id: string, idempotencyKey: string) {
    this.enter("cancelSubscription", idempotencyKey);
    return this.once(`cancel:${idempotencyKey}`, () => {
      const sub = this.subscriptions.get(id);
      if (!sub) throw new StripeApiError(404, "invalid_request_error", "resource_missing", "No such subscription");
      Object.assign(sub, { status: "canceled", canceled_at: this.clock, ended_at: this.clock });
      return structuredClone(sub);
    });
  }

  async listInvoicePayments(invoice: string) {
    this.enter("listInvoicePayments");
    const inv = this.invoices.get(invoice);
    return { data: inv?.status === "paid" && inv.payment_intent ? [{ payment: { type: "payment_intent", payment_intent: inv.payment_intent } }] : [] };
  }

  async createRefund(input: { paymentIntent: string; reason: "duplicate" }, idempotencyKey: string) {
    this.enter("createRefund", idempotencyKey);
    return this.once(`refund:${idempotencyKey}`, () => {
      this.refunds.push({ paymentIntent: input.paymentIntent, reason: input.reason });
      return { id: this.id("re") };
    });
  }

  private newInvoice(sub: StripeSubscription, status: "paid" | "open", billingReason: string): FakeInvoice {
    const id = this.id("in");
    const inv: FakeInvoice = {
      id,
      status,
      billing_reason: billingReason,
      hosted_invoice_url: `https://invoice.stripe.com/i/acct_fake/test_${id}`,
      subscription: sub.id,
      payment_intent: status === "paid" ? this.id("pi") : null,
      attempt_count: 1,
    };
    this.invoices.set(id, inv);
    sub.latest_invoice = id;
    return inv;
  }

  private readonly pendingItems = new Map<string, { id: string; price: { id: string }; current_period_end: number }>();

  /** The customer pays the pending update's invoice: Stripe applies the change. */
  payPending(subId: string): FakeEvent[] {
    const sub = this.subscriptions.get(subId)!;
    const inv = this.invoices.get(sub.latest_invoice as string)!;
    Object.assign(inv, { status: "paid", payment_intent: this.id("pi") });
    sub.items.data.push(this.pendingItems.get(subId)!);
    sub.pending_update = null;
    return [this.event("customer.subscription.pending_update_applied", structuredClone(sub) as unknown as Record<string, unknown>), this.event("invoice.paid", this.invoiceObject(inv, sub))];
  }

  /** Nobody paid: after 23 hours Stripe voids the invoice and drops the change. */
  expirePending(subId: string): FakeEvent {
    const sub = this.subscriptions.get(subId)!;
    const inv = this.invoices.get(sub.latest_invoice as string)!;
    inv.status = "void";
    sub.pending_update = null;
    return this.event("customer.subscription.pending_update_expired", structuredClone(sub) as unknown as Record<string, unknown>);
  }

  /** The event Stripe sends for the pending update's failed payment. */
  pendingPaymentFailed(subId: string): FakeEvent {
    const sub = this.subscriptions.get(subId)!;
    const inv = this.invoices.get(sub.latest_invoice as string)!;
    return this.event("invoice.payment_failed", this.invoiceObject(inv, sub));
  }

  invoiceObject(inv: FakeInvoice, sub: StripeSubscription, nextAttempt: number | null = null): Record<string, unknown> {
    return {
      id: inv.id,
      object: "invoice",
      customer: sub.customer,
      status: inv.status,
      attempt_count: inv.attempt_count,
      next_payment_attempt: nextAttempt,
      billing_reason: inv.billing_reason,
      hosted_invoice_url: inv.hosted_invoice_url,
      parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
    };
  }

  /** Items added with addSubscriptionItem, by subscription; events the test delivers itself. */
  readonly addedItems: { subscription: string; price: string }[] = [];

  async addSubscriptionItem(input: { subscription: string; price: string }, idempotencyKey: string) {
    this.enter("addSubscriptionItem", idempotencyKey);
    return this.once(`item:${idempotencyKey}`, () => {
      const sub = this.subscriptions.get(input.subscription);
      if (!sub) throw new StripeApiError(404, "invalid_request_error", "resource_missing", "No such subscription");
      this.addedItems.push(input);
      const end = sub.items.data[0]!.current_period_end;
      const item = { id: this.id("si"), price: { id: input.price }, current_period_end: end };
      if (this.declineNextUpdate) {
        // The proration invoice's payment fails: the change waits, for 23 hours, on an open invoice.
        this.declineNextUpdate = false;
        this.clock += 60;
        this.newInvoice(sub, "open", "subscription_update");
        sub.pending_update = { expires_at: this.clock + 23 * 3600, subscription_items: [{ price: input.price }] };
        this.pendingItems.set(sub.id, item);
        return { id: item.id };
      }
      sub.items.data.push(item);
      this.newInvoice(sub, "paid", "subscription_update");
      return { id: item.id };
    });
  }

  // --- What Stripe does on its own -------------------------------------------

  event(type: string, object: Record<string, unknown>, livemode = false): FakeEvent {
    return { id: this.id("evt"), object: "event", type, created: this.clock, livemode, api_version: "2026-09-30.endive", data: { object } };
  }

  /** The customer pays in Checkout: a subscription with one item per price, and Stripe's events. */
  completeCheckout(sessionId: string): { subscription: StripeSubscription; events: FakeEvent[] } {
    const session = this.sessions.get(sessionId)!;
    if (session.status !== "open") throw new Error(`fake Stripe: Checkout Session ${sessionId} is ${session.status}; it can't be paid`);
    session.status = "complete";
    const year = 365 * 86_400;
    const sub: StripeSubscription = {
      id: this.id("sub"),
      customer: session.input.customer,
      status: "active",
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      metadata: { ...session.input.metadata },
      items: { data: session.input.prices.map((price) => ({ id: this.id("si"), price: { id: price }, current_period_end: this.clock + year })) },
    };
    this.subscriptions.set(sub.id, sub);
    const first = this.newInvoice(sub, "paid", "subscription_create");
    return {
      subscription: sub,
      events: [
        this.event("customer.subscription.created", structuredClone(sub) as unknown as Record<string, unknown>),
        this.event("checkout.session.completed", {
          id: sessionId,
          object: "checkout.session",
          mode: "subscription",
          customer: sub.customer,
          subscription: sub.id,
          client_reference_id: session.input.accountId,
          metadata: session.input.metadata,
          status: "complete",
          payment_status: "paid",
        }),
        this.event("invoice.paid", this.invoiceObject(first, sub)),
      ],
    };
  }

  /** A renewal invoice, open (failing) or paid. */
  invoice(sub: StripeSubscription, status: "paid" | "open", nextAttempt: number | null = null): Record<string, unknown> {
    const inv = this.newInvoice(sub, status, "subscription_cycle");
    inv.attempt_count = status === "paid" ? 1 : 2;
    return this.invoiceObject(inv, sub, nextAttempt);
  }

  /** Changes the subscription the way Stripe would, and answers the updated event. */
  update(subId: string, change: Partial<Pick<StripeSubscription, "status" | "cancel_at_period_end">>, type = "customer.subscription.updated"): FakeEvent {
    const sub = this.subscriptions.get(subId)!;
    Object.assign(sub, change);
    if (change.status === "canceled") {
      sub.canceled_at = this.clock;
      sub.ended_at = this.clock;
    }
    return this.event(type, structuredClone(sub) as unknown as Record<string, unknown>);
  }

  /** A renewal payment fails; Stripe will retry in three days. */
  failRenewal(subId: string): FakeEvent[] {
    // Some time after the last payment: dunning orders invoices by when they happened.
    this.clock += 60;
    const sub = this.subscriptions.get(subId)!;
    const updated = this.update(subId, { status: "past_due" as SubscriptionStatus });
    return [updated, this.event("invoice.payment_failed", this.invoice(sub, "open", this.clock + 3 * 86_400))];
  }

  /** A payment finally succeeds. */
  pay(subId: string): FakeEvent[] {
    this.clock += 60;
    const sub = this.subscriptions.get(subId)!;
    return [this.update(subId, { status: "active" }), this.event("invoice.paid", this.invoice(sub, "paid"))];
  }

  /** The request Stripe makes to deliver `event`, signed at Stripe's clock (or at `at`, seconds). */
  async signed(url: string, event: FakeEvent, options: { at?: number; secret?: string; body?: string } = {}): Promise<Request> {
    const body = options.body ?? JSON.stringify(event);
    const signature = await signStripePayload(body, options.secret ?? this.webhookSecret, options.at ?? this.clock);
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": signature, "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)" },
      body,
    });
  }
}
