/**
 * The Stripe API calls billing makes, behind one interface: `HttpStripeApi`
 * is the real client over HTTPS, and tests use the in-memory fake in
 * test/fake-stripe.ts, so no test ever reaches Stripe.
 *
 * Every request pins STRIPE_API_VERSION with the Stripe-Version header, so a
 * change to the account's default version in the Stripe dashboard can't
 * change a shape this code reads. The shapes below were checked against
 * Stripe's API reference on 2026-10-28 for that version:
 *   - versioning:        https://docs.stripe.com/api/versioning
 *   - customers:         https://docs.stripe.com/api/customers/create
 *   - Checkout Sessions: https://docs.stripe.com/api/checkout/sessions/create
 *   - portal sessions:   https://docs.stripe.com/api/customer_portal/sessions/create
 *   - subscriptions:     https://docs.stripe.com/api/subscriptions/object
 *     (since the 2025 "basil" release the billing period is on each item,
 *     `items.data[].current_period_end`, not on the subscription)
 *   - subscription items: https://docs.stripe.com/api/subscription_items/create
 *   - invoices:          https://docs.stripe.com/api/invoices/object
 *     (the subscription is `parent.subscription_details.subscription`)
 *   - idempotent requests: https://docs.stripe.com/api/idempotent_requests
 *   - pending updates:   https://docs.stripe.com/billing/subscriptions/pending-updates
 *     (a failed payment leaves `pending_update` set and the open invoice as
 *     `latest_invoice`; the update applies when that invoice is paid, and is
 *     dropped after about 23 hours)
 *   - expiring a Checkout Session: https://docs.stripe.com/api/checkout/sessions/expire
 *     (only an `open` one; anything else answers an error)
 *   - cancelling:        https://docs.stripe.com/api/subscriptions/cancel
 *   - invoice payments:  https://docs.stripe.com/api/invoice-payment/object
 *     (`GET /v1/invoice_payments?invoice=`; each names its `payment.payment_intent`)
 *   - refunds:           https://docs.stripe.com/api/refunds/create
 * Requests are form encoded (`a[b][0]=c`), as the v1 API takes them.
 */

/** The Stripe API version every request is made with. */
export const STRIPE_API_VERSION = "2026-09-30.endive";

const STRIPE_API = "https://api.stripe.com";

export const SUBSCRIPTION_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The parts of a Subscription billing reads. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  metadata: Record<string, string>;
  items: { data: { id: string; price: { id: string }; current_period_end: number }[] };
  /** Set while a change waits for its invoice to be paid (payment_behavior=pending_if_incomplete). */
  pending_update?: { expires_at: number; subscription_items?: { id?: string; price: string }[] } | null;
  /** An id, or the invoice itself when expanded (retrieveSubscription with expandInvoice). */
  latest_invoice?: string | StripeInvoice | null;
}

/** The parts of an Invoice billing reads. */
export interface StripeInvoice {
  id: string;
  status: string | null;
  billing_reason: string | null;
  hosted_invoice_url: string | null;
}

export interface CheckoutInput {
  customer: string;
  /** Price ids, one of each: the yearly plan, and the add-on when asked for. */
  prices: string[];
  successUrl: string;
  cancelUrl: string;
  /** Our account id: Checkout's client_reference_id. */
  accountId: string;
  /** Copied to the Session and to the Subscription it creates, so the webhook can tell whose it is. */
  metadata: Record<string, string>;
  /** Stripe Tax: automatic_tax[enabled], with the customer's address saved from Checkout. */
  automaticTax: boolean;
}

export interface StripeApi {
  /** POST /v1/customers. The idempotency key makes a retried or doubled call return the same Customer. */
  createCustomer(input: { email: string; accountId: string }, idempotencyKey: string): Promise<{ id: string }>;
  /** POST /v1/customers/:id with a new email: receipts and Stripe's own emails follow an account's email change. */
  updateCustomerEmail(id: string, email: string, idempotencyKey: string): Promise<{ id: string }>;
  /** POST /v1/checkout/sessions in subscription mode. */
  createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }>;
  /** POST /v1/billing_portal/sessions. */
  createPortalSession(input: { customer: string; returnUrl: string; configuration?: string }): Promise<{ url: string }>;
  /** GET /v1/subscriptions/:id: the current truth, whatever order the webhooks came in; `expandInvoice` expands latest_invoice. */
  retrieveSubscription(id: string, options?: { expandInvoice?: boolean }): Promise<StripeSubscription>;
  /** POST /v1/checkout/sessions/:id/expire: an open session can't be paid any more. */
  expireCheckoutSession(id: string): Promise<{ id: string; status: string }>;
  /** DELETE /v1/subscriptions/:id: ends it now, no proration. */
  cancelSubscription(id: string, idempotencyKey: string): Promise<StripeSubscription>;
  /** GET /v1/invoice_payments?invoice=...&status=paid: the PaymentIntents that paid an invoice. */
  listInvoicePayments(invoice: string): Promise<{ data: { payment: { type: string; payment_intent?: string } }[] }>;
  /** POST /v1/refunds for the whole of a PaymentIntent. */
  createRefund(input: { paymentIntent: string; reason: "duplicate" }, idempotencyKey: string): Promise<{ id: string }>;
  /** POST /v1/subscription_items: adds the 1-minute add-on to a paid subscription, invoiced now. */
  addSubscriptionItem(input: { subscription: string; price: string }, idempotencyKey: string): Promise<{ id: string }>;
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }

  /** A 409 (idempotency key in flight), 429 or 5xx is worth trying again; a 4xx otherwise isn't. */
  get retryable(): boolean {
    return this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Stripe's form encoding: nested objects and arrays as `a[b][0][c]=v`; null and undefined are left out. */
export function stripeForm(params: Record<string, FormValue>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: FormValue) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    else out.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

/** The body of a Checkout Session for these inputs (kept apart so tests can check it as Stripe would get it). */
export function checkoutParams(input: CheckoutInput): Record<string, FormValue> {
  return {
    mode: "subscription",
    customer: input.customer,
    client_reference_id: input.accountId,
    line_items: input.prices.map((price) => ({ price, quantity: 1 })),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata,
    subscription_data: { metadata: input.metadata },
    // Stripe Tax works out the tax from the customer's address; with an
    // existing Customer, Checkout must be allowed to save the address it
    // collects (customer_update[address]=auto), or the session is refused.
    automatic_tax: { enabled: input.automaticTax },
    customer_update: input.automaticTax ? { address: "auto", name: "auto" } : undefined,
    billing_address_collection: input.automaticTax ? "required" : "auto",
    tax_id_collection: input.automaticTax ? { enabled: true } : undefined,
    allow_promotion_codes: true,
  };
}

export class HttpStripeApi implements StripeApi {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly secretKey: string,
    fetcher?: typeof fetch,
  ) {
    const f = fetcher ?? fetch;
    this.fetcher = (input, init) => f(input, init);
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers = new Headers({ authorization: `Bearer ${this.secretKey}`, "stripe-version": STRIPE_API_VERSION });
    let body: string | undefined;
    if (params) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = stripeForm(params).toString();
    }
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    let res: Response;
    try {
      res = await this.fetcher(`${STRIPE_API}${path}`, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new StripeApiError(0, null, null, `no answer from Stripe: ${error instanceof Error ? error.message : String(error)}`);
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { type?: string; code?: string; message?: string } }) | null;
    if (!res.ok || !json) {
      const e = json?.error;
      // Stripe's messages are safe to log; they never echo the key.
      throw new StripeApiError(res.status, e?.type ?? null, e?.code ?? null, `Stripe ${method} ${path} answered ${res.status}${e?.message ? `: ${e.message}` : ""}`);
    }
    return json;
  }

  createCustomer(input: { email: string; accountId: string }, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", "/v1/customers", { email: input.email, metadata: { account_id: input.accountId } }, idempotencyKey);
  }

  createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }> {
    return this.request("POST", "/v1/checkout/sessions", checkoutParams(input), idempotencyKey);
  }

  createPortalSession(input: { customer: string; returnUrl: string; configuration?: string }): Promise<{ url: string }> {
    return this.request("POST", "/v1/billing_portal/sessions", {
      customer: input.customer,
      return_url: input.returnUrl,
      configuration: input.configuration,
    });
  }

  retrieveSubscription(id: string, options: { expandInvoice?: boolean } = {}): Promise<StripeSubscription> {
    const query = options.expandInvoice ? "?expand[]=latest_invoice" : "";
    return this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}${query}`);
  }

  updateCustomerEmail(id: string, email: string, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", `/v1/customers/${encodeURIComponent(id)}`, { email }, idempotencyKey);
  }

  expireCheckoutSession(id: string): Promise<{ id: string; status: string }> {
    return this.request("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
  }

  cancelSubscription(id: string, idempotencyKey: string): Promise<StripeSubscription> {
    // Stripe's libraries send a DELETE's parameters in the query string.
    const query = stripeForm({ invoice_now: false, prorate: false }).toString();
    return this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}?${query}`, undefined, idempotencyKey);
  }

  listInvoicePayments(invoice: string): Promise<{ data: { payment: { type: string; payment_intent?: string } }[] }> {
    return this.request("GET", `/v1/invoice_payments?${stripeForm({ invoice, status: "paid" }).toString()}`);
  }

  createRefund(input: { paymentIntent: string; reason: "duplicate" }, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", "/v1/refunds", { payment_intent: input.paymentIntent, reason: input.reason }, idempotencyKey);
  }

  addSubscriptionItem(input: { subscription: string; price: string }, idempotencyKey: string): Promise<{ id: string }> {
    return this.request(
      "POST",
      "/v1/subscription_items",
      {
        subscription: input.subscription,
        price: input.price,
        quantity: 1,
        // Charge the rest of this year's add-on now, and change nothing unless that payment succeeds.
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      },
      idempotencyKey,
    );
  }
}
