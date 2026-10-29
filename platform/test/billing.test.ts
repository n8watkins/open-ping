import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PlatformCapability, TenantProps } from "../../src/shared/hosted-contract";
import { createApp } from "../src/app";
import { createSession } from "../src/auth/sessions";
import { billingSetup, type BillingSetup } from "../src/billing/config";
import { parseSignatureHeader, signStripePayload, verifyStripeSignature } from "../src/billing/signature";
import { ENDED_TRIALS_SQL, endTrials, packsForItems, planForPrices, stateForStatus } from "../src/billing/state";
import { PRICE_TEXT, yearlyTotal } from "../src/billing/pages";
import { TRIAL_DAYS } from "../src/provisioning";
import { HttpStripeApi, STRIPE_API_VERSION, StripeApiError, checkoutParams, stripeForm } from "../src/billing/stripe";
import type { PlatformEnv } from "../src/env";
import type { Mailer, OutgoingEmail } from "../src/mail";
import { DUE_SQL } from "../src/scheduling";
import { OLD_EMAILS_SQL, OLD_EVENTS_SQL, billingRecordsCleanup } from "../src/billing/webhook";
import { clearTenantCache } from "../src/tenants";
import { FakeDispatcher } from "./fake-dispatcher";
import { FakeStripe, type FakeEvent } from "./fake-stripe";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
const PRICE_HOSTED = "price_hostedYearly24";
const PRICE_FAST = "price_fastAddon24";
const PRICE_MONITOR_PACK = "price_monitorPack24";
const PRICE_FAST_PACK = "price_fastPack36";
const DAY = 86_400_000;

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

class Outbox implements Mailer {
  sent: OutgoingEmail[] = [];
  async send(message: OutgoingEmail) {
    this.sent.push(message);
    return { ok: true as const, id: `m${this.sent.length}` };
  }
}

let stripe: FakeStripe;
let outbox: Outbox;
let billingOn = true;
const clock = { now: Date.UTC(2026, 10, 2, 12) };
const dispatcher = new FakeDispatcher();

function setup(): BillingSetup {
  if (!billingOn) return { ok: false, missing: ["STRIPE_SECRET_KEY"] };
  return {
    ok: true,
    stripe,
    config: {
      webhookSecret: stripe.webhookSecret,
      priceHosted: PRICE_HOSTED,
      priceFast: PRICE_FAST,
      priceMonitorPack: PRICE_MONITOR_PACK,
      priceFastPack: PRICE_FAST_PACK,
      automaticTax: true,
      portalConfiguration: null,
      live: false,
    },
  };
}

const app = createApp({
  dispatcher: () => dispatcher,
  capability: () => noopPlatform,
  accounts: {
    mailer: () => outbox,
    provisioning: () => ({ ok: false, missing: ["off in these tests"] }),
    billing: () => setup(),
    now: () => clock.now,
  },
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, env as unknown as PlatformEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A signed-in customer with a ready OpenPing on a trial. */
async function customer(options: { trialEndsAt?: number; status?: string } = {}) {
  const n = crypto.randomUUID().slice(0, 8);
  const accountId = `acc_bill${n}`;
  const tenantId = `bill${n}${"0".repeat(8)}`.slice(0, 16);
  const slug = `bill${n}`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(accountId, `${slug}@example.com`),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, trial_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'trial', 'ready', ?, 0, 0)`,
    ).bind(tenantId, accountId, slug, `t-${tenantId}`, options.status ?? "trial", options.trialEndsAt ?? clock.now + 10 * DAY),
  ]);
  const cookie = (await createSession(env.PLATFORM_DB, accountId, "email", clock.now)).split(";")[0]!;
  dispatcher.register(`t-${tenantId}`, (_request, props) => Response.json(props.tenant));
  const browser = (path: string, init: { form?: Record<string, string>; origin?: string } = {}) =>
    call(
      new Request(`${APP}${path}`, {
        method: init.form ? "POST" : "GET",
        headers: { cookie, ...(init.form ? { origin: init.origin ?? APP, "content-type": "application/x-www-form-urlencoded" } : {}) },
        body: init.form ? new URLSearchParams(init.form) : undefined,
        redirect: "manual",
      }),
    );
  return { accountId, tenantId, slug, browser };
}

async function tenantRow(id: string) {
  return (await env.PLATFORM_DB.prepare("SELECT status, plan, billing_reason, suspended_at, owner_suspended_at, owner_suspended_reason FROM tenants WHERE id = ?")
    .bind(id)
    .first<Record<string, string | number | null>>())!;
}

const deliver = async (event: FakeEvent, options: Parameters<FakeStripe["signed"]>[2] = {}) => call(await stripe.signed(`${APP}/stripe/webhook`, event, options));

async function deliverAll(events: FakeEvent[]) {
  for (const e of events) expect((await deliver(e)).status, e.type).toBe(200);
}

/** What the tenant's OpenPing is told on its next public request. */
async function tenantSees(slug: string): Promise<TenantProps["tenant"] | number> {
  const res = await call(new Request(`https://${slug}.${DOMAIN}/`));
  return res.status === 200 ? ((await res.json()) as TenantProps["tenant"]) : res.status;
}

describe("an account being deleted", () => {
  it("expires its open Checkout, and cancels and refunds a subscription that starts anyway", async () => {
    const c = await customer();
    const res = await c.browser("/billing/checkout", { form: { plan: "hosted" } });
    const sessionId = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await res.text())![1]!.split("/").at(-1)!;
    // The deletion expires the open page, so it can't be paid.
    expect((await c.browser("/account/delete", { form: { confirm: `${c.slug}@example.com` } })).status).toBe(200);
    expect(stripe.sessions.get(sessionId)!.status).toBe("expired");
    expect((await env.PLATFORM_DB.prepare("SELECT checkout_session_id FROM accounts WHERE id = ?").bind(c.accountId).first("checkout_session_id"))).toBeNull();

    // A second customer whose expire didn't reach Stripe pays a moment later: billing undoes it.
    const d = await customer();
    const res2 = await d.browser("/billing/checkout", { form: { plan: "hosted" } });
    const second = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await res2.text())![1]!.split("/").at(-1)!;
    stripe.failNext("expireCheckoutSession", 503);
    await d.browser("/account/delete", { form: { confirm: `${d.slug}@example.com` } });
    const paid = stripe.completeCheckout(second);
    await deliverAll(paid.events);
    expect(stripe.subscriptions.get(paid.subscription.id)!.status).toBe("canceled");
    expect(stripe.refunds).toHaveLength(1);
    const audited = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE account_id = ? AND action = 'billing.deleted_account_refunded'").bind(d.accountId).first<{ detail: string }>();
    expect(JSON.parse(audited!.detail)).toMatchObject({ subscription: paid.subscription.id, refunds: 1 });
    // Its OpenPing stays paused.
    expect((await tenantRow(d.tenantId)).owner_suspended_at).not.toBeNull();
  });

  it("cancels a live plan, and when Stripe fails, still starts the deletion and says the cancellation is retried", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    stripe.failNext("cancelSubscription", 503);
    const res = await c.browser("/account/delete", { form: { confirm: `${c.slug}@example.com` } });
    expect(await res.text()).toContain("we keep trying until it does");
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("active");
    expect(await env.PLATFORM_DB.prepare("SELECT deletion_requested_at FROM accounts WHERE id = ?").bind(c.accountId).first("deletion_requested_at")).not.toBeNull();
    const { settleAccountBilling } = await import("../src/account-deletion");
    expect(await settleAccountBilling(env.PLATFORM_DB, stripe, c.accountId, clock.now)).toBe(true);
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("canceled");
    expect(await settleAccountBilling(env.PLATFORM_DB, stripe, c.accountId, clock.now)).toBe(true);
  });
});

describe("an email change", () => {
  it("moves the Stripe customer's email too, so receipts follow", async () => {
    const c = await customer();
    await subscribe(c);
    const { stripe_customer_id: id } = (await env.PLATFORM_DB.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(c.accountId).first<{ stripe_customer_id: string }>())!;
    const page = await c.browser("/account/email", { form: { email: `moved-${c.slug}@example.com` } });
    const changeId = /name="change" value="([^"]+)"/.exec(await page.text())![1]!;
    const code = /Code: (\d{6})/.exec(outbox.sent.at(-1)!.text)![1]!;
    expect((await c.browser("/account/email/confirm", { form: { change: changeId, code } })).status).toBe(303);
    expect(stripe.customers.get(id)!.email).toBe(`moved-${c.slug}@example.com`);
  });
});

/** Signs up for `plan` through Checkout and Stripe; answers the subscription. */
async function subscribe(c: Awaited<ReturnType<typeof customer>>, plan: "hosted" | "hosted_fast" = "hosted") {
  const res = await c.browser("/billing/checkout", { form: { plan } });
  expect(res.status).toBe(200);
  const href = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await res.text())![1]!;
  const sessionId = href.split("/").at(-1)!;
  const done = stripe.completeCheckout(sessionId);
  await deliverAll(done.events);
  return done.subscription;
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  stripe = new FakeStripe();
  outbox = new Outbox();
  billingOn = true;
  clock.now = Date.UTC(2026, 10, 2, 12);
  stripe.clock = Math.floor(clock.now / 1000);
  clearTenantCache();
});

// ---------------------------------------------------------------------------

describe("the webhook signature", () => {
  const secret = "whsec_test_vector_not_a_secret";
  const body = '{"id":"evt_test_vector","object":"event"}';
  const t = 1730000000;
  // HMAC-SHA256 of "1730000000.<body>" keyed with the secret, from Node's crypto: an independent check.
  const VECTOR = "aaa92347a285fb5c65bc1446993b8a214a1da1a61c80443347ea988dee4d3f6e";
  const now = t * 1000;

  it("matches Stripe's scheme exactly", async () => {
    expect(await signStripePayload(body, secret, t)).toBe(`t=${t},v1=${VECTOR}`);
    expect(await verifyStripeSignature({ body, header: `t=${t},v1=${VECTOR},v0=${"0".repeat(64)}`, secret, now })).toEqual({ ok: true, timestamp: t });
  });

  it("accepts any one of several v1 signatures (a rolled secret), and ignores other schemes", async () => {
    const other = "a".repeat(64);
    expect((await verifyStripeSignature({ body, header: `t=${t},v1=${other},v1=${VECTOR}`, secret, now })).ok).toBe(true);
    // A v0 with the right value isn't enough: only v1 counts.
    expect(await verifyStripeSignature({ body, header: `t=${t},v0=${VECTOR}`, secret, now })).toEqual({ ok: false, reason: "no_match" });
  });

  it("refuses a changed body, a wrong secret, a missing or malformed header, and stale or future times", async () => {
    const header = `t=${t},v1=${VECTOR}`;
    expect(await verifyStripeSignature({ body: body.replace("vector", "vectoR"), header, secret, now })).toEqual({ ok: false, reason: "no_match" });
    expect(await verifyStripeSignature({ body, header, secret: `${secret}x`, now })).toEqual({ ok: false, reason: "no_match" });
    expect(await verifyStripeSignature({ body, header: null, secret, now })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyStripeSignature({ body, header: `v1=${VECTOR}`, secret, now })).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyStripeSignature({ body, header, secret, now: now + 301_000 })).toEqual({ ok: false, reason: "too_old" });
    expect(await verifyStripeSignature({ body, header, secret, now: now - 301_000 })).toEqual({ ok: false, reason: "in_future" });
    expect((await verifyStripeSignature({ body, header, secret, now: now + 299_000 })).ok).toBe(true);
    // A tolerance of 0 would turn the check off; it is never used.
    expect(await verifyStripeSignature({ body, header, secret, now: now + 3_600_000, toleranceSeconds: 0 })).toEqual({ ok: false, reason: "too_old" });
  });

  it("parses the header the way Stripe describes it", () => {
    expect(parseSignatureHeader(`t=${t}, v1=${VECTOR} ,v0=x,junk`)).toEqual({ timestamp: t, signatures: [VECTOR] });
    expect(parseSignatureHeader("t=abc,v1=x")).toBeNull();
    expect(parseSignatureHeader("x".repeat(5000))).toBeNull();
  });
});

describe("the Stripe client", () => {
  function recording(answer: (url: string, init: RequestInit) => Response) {
    const seen: { url: string; method: string; headers: Headers; body: string }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return answer(String(input), init ?? {});
    }) as typeof fetch;
    return { api: new HttpStripeApi("sk_test_123", fetcher), seen };
  }

  it("pins the API version, sends the key and the idempotency key, and form-encodes Checkout as Stripe documents", async () => {
    const { api, seen } = recording(() => Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    const input = {
      customer: "cus_1",
      items: [
        { price: PRICE_HOSTED, quantity: 1 },
        { price: PRICE_FAST, quantity: 1 },
        { price: PRICE_MONITOR_PACK, quantity: 2 },
      ],
      successUrl: `${APP}/billing?done=welcome`,
      cancelUrl: `${APP}/billing`,
      accountId: "acc_1",
      metadata: { account_id: "acc_1", tenant_id: "t1", plan: "hosted_fast" },
      automaticTax: true,
    };
    expect(await api.createCheckoutSession(input, "checkout-acc_1")).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const r = seen[0]!;
    expect(r.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(r.method).toBe("POST");
    expect(r.headers.get("authorization")).toBe("Bearer sk_test_123");
    expect(r.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION).toBe("2026-09-30.endive");
    expect(r.headers.get("idempotency-key")).toBe("checkout-acc_1");
    expect(r.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = Object.fromEntries(new URLSearchParams(r.body));
    expect(form).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: "acc_1",
      "line_items[0][price]": PRICE_HOSTED,
      "line_items[0][quantity]": "1",
      "line_items[1][price]": PRICE_FAST,
      "line_items[2][price]": PRICE_MONITOR_PACK,
      "line_items[2][quantity]": "2",
      "metadata[account_id]": "acc_1",
      "subscription_data[metadata][tenant_id]": "t1",
      "automatic_tax[enabled]": "true",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "tax_id_collection[enabled]": "true",
      billing_address_collection: "required",
    });
    // Stripe Tax off: no address saving needed.
    expect(stripeForm(checkoutParams({ ...input, automaticTax: false })).get("customer_update[address]")).toBeNull();
  });

  it("adds the add-on invoiced now and only if paid, and reads subscriptions with a GET", async () => {
    const { api, seen } = recording((url) => Response.json(url.includes("subscriptions/") ? { id: "sub_1" } : { id: "si_1" }));
    await api.addSubscriptionItem({ subscription: "sub_1", price: PRICE_FAST }, "add-fast-sub_1");
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      subscription: "sub_1",
      price: PRICE_FAST,
      quantity: "1",
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    await api.retrieveSubscription("sub_1");
    expect(seen[1]).toMatchObject({ url: "https://api.stripe.com/v1/subscriptions/sub_1", method: "GET", body: "" });
    await api.createPortalSession({ customer: "cus_1", returnUrl: `${APP}/billing` });
    expect(Object.fromEntries(new URLSearchParams(seen[2]!.body))).toEqual({ customer: "cus_1", return_url: `${APP}/billing` });
  });

  it("expires sessions, cancels without proration, lists an invoice's payments and refunds, as Stripe documents", async () => {
    const { api, seen } = recording(() => Response.json({ id: "x", status: "expired", data: [] }));
    await api.expireCheckoutSession("cs_test_1");
    await api.cancelSubscription("sub_1", "duplicate-cancel-sub_1");
    await api.listInvoicePayments("in_1");
    await api.createRefund({ paymentIntent: "pi_1", reason: "duplicate" }, "duplicate-refund-pi_1");
    await api.retrieveSubscription("sub_1", { expandInvoice: true });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://api.stripe.com/v1/checkout/sessions/cs_test_1/expire",
      "DELETE https://api.stripe.com/v1/subscriptions/sub_1?invoice_now=false&prorate=false",
      "GET https://api.stripe.com/v1/invoice_payments?invoice=in_1&status=paid",
      "POST https://api.stripe.com/v1/refunds",
      "GET https://api.stripe.com/v1/subscriptions/sub_1?expand[]=latest_invoice",
    ]);
    expect(seen[1]!.headers.get("idempotency-key")).toBe("duplicate-cancel-sub_1");
    expect(Object.fromEntries(new URLSearchParams(seen[3]!.body))).toEqual({ payment_intent: "pi_1", reason: "duplicate" });
  });

  it("turns Stripe's errors into StripeApiError, retryable only when trying again can help", async () => {
    const { api } = recording(() => Response.json({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }, { status: 402 }));
    const error = await api.createCustomer({ email: "a@example.com", accountId: "acc_1" }, "k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({ status: 402, code: "card_declined", retryable: false });
    expect(new StripeApiError(503, null, null, "").retryable).toBe(true);
    expect(new StripeApiError(409, null, null, "").retryable).toBe(true);
  });
});

describe("billing's settings", () => {
  const base = {
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_HOSTED: PRICE_HOSTED,
    STRIPE_PRICE_FAST: PRICE_FAST,
    STRIPE_PRICE_MONITOR_PACK: PRICE_MONITOR_PACK,
    STRIPE_PRICE_FAST_PACK: PRICE_FAST_PACK,
  } as PlatformEnv;

  it("are complete with test keys and all four prices, Stripe Tax on by default", () => {
    const s = billingSetup(base);
    expect(s.ok && s.config).toMatchObject({
      automaticTax: true,
      live: false,
      priceHosted: PRICE_HOSTED,
      priceFast: PRICE_FAST,
      priceMonitorPack: PRICE_MONITOR_PACK,
      priceFastPack: PRICE_FAST_PACK,
    });
    const off = billingSetup({ ...base, STRIPE_TAX: "off" });
    expect(off.ok && off.config.automaticTax).toBe(false);
  });

  it("refuse a live key in test mode, and a test key in live mode", () => {
    expect(billingSetup({ ...base, STRIPE_SECRET_KEY: "sk_live_abc" })).toEqual({ ok: false, missing: ["STRIPE_SECRET_KEY (a live key: set STRIPE_MODE to live to use it)"] });
    expect(billingSetup({ ...base, STRIPE_MODE: "live" })).toEqual({ ok: false, missing: ["STRIPE_SECRET_KEY (a test key, but STRIPE_MODE is live)"] });
    expect(billingSetup({ ...base, STRIPE_SECRET_KEY: "rk_live_abc", STRIPE_MODE: "live" }).ok).toBe(true);
  });

  it("name everything missing", () => {
    expect(billingSetup({} as PlatformEnv)).toEqual({
      ok: false,
      missing: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_HOSTED", "STRIPE_PRICE_FAST", "STRIPE_PRICE_MONITOR_PACK", "STRIPE_PRICE_FAST_PACK"],
    });
    // One Price can't be two things.
    expect(billingSetup({ ...base, STRIPE_PRICE_FAST: PRICE_HOSTED })).toEqual({ ok: false, missing: ["STRIPE_PRICE_FAST"] });
    expect(billingSetup({ ...base, STRIPE_PRICE_FAST_PACK: PRICE_MONITOR_PACK })).toEqual({ ok: false, missing: ["STRIPE_PRICE_FAST_PACK"] });
    expect(billingSetup({ ...base, STRIPE_PRICE_MONITOR_PACK: "not-a-price" })).toEqual({ ok: false, missing: ["STRIPE_PRICE_MONITOR_PACK"] });
  });
});

describe("the state machine", () => {
  it("maps each Stripe status to the tenant's", () => {
    expect(stateForStatus("active")).toEqual({ status: "active", reason: null });
    expect(stateForStatus("trialing")).toEqual({ status: "active", reason: null });
    expect(stateForStatus("past_due")).toEqual({ status: "past_due", reason: null });
    expect(stateForStatus("unpaid")).toEqual({ status: "suspended", reason: "unpaid" });
    expect(stateForStatus("paused")).toEqual({ status: "suspended", reason: "paused" });
    expect(stateForStatus("canceled")).toEqual({ status: "suspended", reason: "canceled" });
    expect(stateForStatus("incomplete")).toBeNull();
    expect(stateForStatus("incomplete_expired")).toBeNull();
  });

  it("tells the plans apart by price", () => {
    const config = { priceHosted: PRICE_HOSTED, priceFast: PRICE_FAST };
    expect(planForPrices([PRICE_HOSTED], config)).toBe("hosted");
    expect(planForPrices([PRICE_FAST, PRICE_HOSTED], config)).toBe("hosted_fast");
    expect(planForPrices([PRICE_FAST], config)).toBeNull();
    expect(planForPrices(["price_other"], config)).toBeNull();
  });
});

describe("a customer's billing", () => {
  it("starts on a trial with no card, and subscribes through Checkout with Stripe Tax", async () => {
    const c = await customer();
    const account = await (await c.browser("/account")).text();
    expect(account).toContain("Trial, 10 days left");
    expect(account).toContain("Subscribe for $24 a year");
    expect(account).toContain("1\u2011minute checks: $48\u00a0a\u00a0year");

    const res = await c.browser("/billing/checkout", { form: { plan: "hosted" } });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toMatch(/<meta http-equiv="refresh" content="0;url=https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_fake[0-9a-f]{8}\d{4}">/);
    const [session] = [...stripe.sessions.values()];
    expect(session!.input).toMatchObject({
      items: [{ price: PRICE_HOSTED, quantity: 1 }],
      automaticTax: true,
      accountId: c.accountId,
      metadata: { account_id: c.accountId, tenant_id: c.tenantId, plan: "hosted" },
      successUrl: `${APP}/billing?done=welcome`,
      cancelUrl: `${APP}/billing`,
    });
    // One Customer per account, however often Checkout starts, and one open session:
    // starting again expires the first, so only the latest can take a payment.
    await c.browser("/billing/checkout", { form: { plan: "hosted_fast" } });
    await c.browser("/billing/checkout", { form: { plan: "hosted" } });
    expect(stripe.customers.size).toBe(1);
    expect(stripe.calls.filter((x) => x.method === "createCustomer")).toHaveLength(1);
    const sessions = [...stripe.sessions.values()];
    expect(sessions.map((x) => x.status)).toEqual(["expired", "expired", "open"]);

    // Nothing changes until Stripe says so.
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "trial", plan: "trial" });
    await deliverAll(stripe.completeCheckout(sessions[2]!.id).events);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted", billing_reason: null });
    // The next call to the tenant carries the new plan's limits.
    expect(await tenantSees(c.slug)).toMatchObject({ status: "active", plan: "hosted", limits: { monitors: 20, minIntervalMinutes: 12 }, trialEndsAt: null });

    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Renews on Nov 2, 2027 for $24 a year.");
    expect(billing).toContain("Add for $24 a year");
    expect(billing).toContain("Manage billing");
  });

  it("adds 1-minute checks to a paid plan, applied when Stripe confirms", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    expect((await c.browser("/billing/add-fast", { form: {} })).headers.get("location")).toBe("/billing?done=upgrading");
    expect(stripe.addedItems).toEqual([{ subscription: sub.id, price: PRICE_FAST, quantity: 1 }]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ plan: "hosted" });
    await deliverAll([stripe.update(sub.id, {})]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted_fast" });
    expect(await tenantSees(c.slug)).toMatchObject({ plan: "hosted_fast", limits: { minIntervalMinutes: 1, fastMonitors: 5 } });
    // Asked again: nothing more to add.
    expect((await c.browser("/billing/add-fast", { form: {} })).headers.get("location")).toBe("/billing?done=already-fast");
    // The upgrade page now offers more fast monitors instead.
    expect(await (await c.browser("/billing/upgrade?need=fast_monitors")).text()).toContain("Add 5 fast monitors: $36\u00a0a\u00a0year");
  });

  it("subscribes a trial straight to 1-minute checks from the upgrade page", async () => {
    const c = await customer();
    const upgrade = await (await c.browser("/billing/upgrade")).text();
    expect(upgrade).toContain("<h1>Choose your plan</h1>");
    expect(upgrade.indexOf("1\u2011minute checks: $48")).toBeGreaterThan(0);
    expect(upgrade.indexOf("1\u2011minute checks: $48")).toBeLessThan(upgrade.indexOf("Subscribe for $24 a year"));
    await subscribe(c, "hosted_fast");
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted_fast" });
  });

  it("runs dunning: past due keeps checking and emails the customer, paying restores it", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    await deliverAll(stripe.failRenewal(sub.id));
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "past_due", plan: "hosted" });
    expect(await tenantSees(c.slug)).toMatchObject({ status: "past_due" });
    const mail = outbox.sent.at(-1)!;
    expect(mail).toMatchObject({ to: `${c.slug}@example.com`, subject: "Your OpenPing Hosted payment didn't go through" });
    expect(mail.text).toContain("Stripe will try your card again on November 5.");
    expect(mail.text).toContain(`${APP}/billing`);
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Your last payment didn&#39;t go through. Stripe tries again on Nov 5, 2026");
    expect(billing).toContain("Update payment method");

    await deliverAll(stripe.pay(sub.id));
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active" });
    expect(await (await c.browser("/billing")).text()).not.toContain("didn&#39;t go through");
  });

  it("suspends as cancelled when Stripe cancels after its last retry (D11), and offers to subscribe again", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    await deliverAll(stripe.failRenewal(sub.id));
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "past_due" });
    // Stripe's last retry fails: it cancels the subscription and sends customer.subscription.deleted.
    await deliverAll([stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted")]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled", suspended_at: clock.now });
    expect(await tenantSees(c.slug)).toBe(503);
    const due = await env.PLATFORM_DB.prepare(DUE_SQL).bind(Date.now() + DAY, Date.now(), 100).all<{ id: string }>();
    expect(due.results.map((r) => r.id)).not.toContain(c.tenantId);
    const account = await (await c.browser("/account")).text();
    expect(account).toContain("see Billing below to turn it back on");
    expect(account).toContain("Your monitors and history are kept for 30 days.");
    expect(account).toContain("Subscribe for $24 a year");
    await subscribe(c);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", billing_reason: null, suspended_at: null });
  });

  it("suspends when Stripe's retries run out, takes it off the scheduler, and lifts it when paid", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    await deliverAll([stripe.update(sub.id, { status: "unpaid" })]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "unpaid", suspended_at: clock.now });
    expect(await tenantSees(c.slug)).toBe(503);
    const due = await env.PLATFORM_DB.prepare(DUE_SQL).bind(Date.now() + DAY, Date.now(), 100).all<{ id: string }>();
    expect(due.results.map((r) => r.id)).not.toContain(c.tenantId);
    const account = await (await c.browser("/account")).text();
    expect(account).toContain("see Billing below to turn it back on");
    expect(account).toContain("Pay and turn it back on");

    await deliverAll(stripe.pay(sub.id));
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", billing_reason: null, suspended_at: null });
  });

  it("never lifts the owner's suspension, and leaves the owner's columns alone", async () => {
    const c = await customer();
    await env.PLATFORM_DB.prepare("UPDATE tenants SET owner_suspended_at = ?, owner_suspended_reason = 'phishing' WHERE id = ?").bind(clock.now - 1000, c.tenantId).run();
    await subscribe(c);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", owner_suspended_at: clock.now - 1000, owner_suspended_reason: "phishing" });
    expect(await tenantSees(c.slug)).toBe(503);
    expect(await (await c.browser("/account")).text()).toContain("Write to support to restore it.");
  });

  it("stops at once on cancellation, and offers a new subscription", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    await deliverAll([stripe.update(sub.id, { cancel_at_period_end: true })]);
    expect(await (await c.browser("/billing")).text()).toContain("Ends on Nov 2, 2027; it won&#39;t renew.");
    await deliverAll([stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted")]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Your subscription ended on Nov 2, 2026.");
    expect(billing).toContain("Subscribe for $24 a year");
    await subscribe(c);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", billing_reason: null });
  });

  it("refuses a second Checkout while a plan is paid", async () => {
    const c = await customer();
    await subscribe(c);
    expect((await c.browser("/billing/checkout", { form: { plan: "hosted" } })).headers.get("location")).toBe("/billing?done=already-paid");
    expect(stripe.sessions.size).toBe(1);
  });

  it("opens the Customer Portal, back to /billing", async () => {
    const c = await customer();
    expect((await c.browser("/billing/portal", { form: {} })).headers.get("location")).toBe("/billing?done=no-customer");
    await subscribe(c);
    const page = await (await c.browser("/billing/portal", { form: {} })).text();
    expect(page).toContain('content="0;url=https://billing.stripe.com/p/session/test_1"');
    expect(stripe.portals).toEqual([{ customer: [...stripe.customers.keys()][0], returnUrl: `${APP}/billing`, configuration: undefined }]);
  });

  it("says so when Stripe can't be reached, and charges nothing", async () => {
    const c = await customer();
    stripe.failNext("createCheckoutSession", 503);
    const res = await c.browser("/billing/checkout", { form: { plan: "hosted" } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("We couldn&#39;t reach Stripe just now. Nothing was charged");
  });

  it("refuses billing posts from another site", async () => {
    const c = await customer();
    expect((await c.browser("/billing/checkout", { form: { plan: "hosted" }, origin: "https://evil.example" })).status).toBe(403);
    expect(stripe.calls).toEqual([]);
  });

  it("says paid plans open soon while billing isn't set up", async () => {
    billingOn = false;
    const c = await customer();
    expect(await (await c.browser("/account")).text()).toContain("Paid plans open soon");
    expect((await c.browser("/billing/checkout", { form: { plan: "hosted" } })).headers.get("location")).toBe("/billing");
  });
});

describe("the webhook", () => {
  it("processes an event once, however often Stripe delivers it", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const [failed] = stripe.failRenewal(sub.id);
    expect(await (await deliver(failed!)).json()).toEqual({ received: true });
    const sentBefore = outbox.sent.length;
    const again = await deliver(failed!);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(outbox.sent.length).toBe(sentBefore);
  });

  it("answers 409 while another delivery of the same event is being processed", async () => {
    const event = stripe.event("customer.subscription.updated", { id: "sub_none" });
    await env.PLATFORM_DB.prepare("INSERT INTO stripe_events (id, type, created, received_at, processing_until) VALUES (?, ?, 0, 0, ?)")
      .bind(event.id, event.type, clock.now + 30_000)
      .run();
    expect((await deliver(event)).status).toBe(409);
  });

  it("uses Stripe's current subscription, whatever order events arrive in", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const stale = stripe.update(sub.id, {});
    await deliverAll([stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted")]);
    // An older "updated" arriving late still says active in its copy; the fetched subscription says canceled.
    expect(stale.data.object.status).toBe("active");
    await deliverAll([stale]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
  });

  it("leaves an event unprocessed when Stripe can't be reached, so the retry runs it", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const [updated] = stripe.failRenewal(sub.id);
    stripe.failNext("retrieveSubscription", 500);
    expect((await deliver(updated!)).status).toBe(500);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active" });
    expect((await deliver(updated!)).status).toBe(200);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "past_due" });
  });

  it("refuses unsigned, wrongly signed, stale, and live-mode events, and changes nothing", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const event = stripe.update(sub.id, { status: "unpaid" });
    const unsigned = new Request(`${APP}/stripe/webhook`, { method: "POST", body: JSON.stringify(event) });
    expect((await call(unsigned)).status).toBe(400);
    expect((await deliver(event, { secret: "whsec_someone_else" })).status).toBe(400);
    expect((await deliver(event, { at: stripe.clock - 600 })).status).toBe(400);
    expect((await deliver(event, { body: JSON.stringify({ ...event, livemode: false, id: "evt_tampered" }) })).status).toBe(200);
    // That last one was signed over its own body, so it's genuine; a live event never is, here.
    expect((await deliver({ ...event, id: "evt_live1", livemode: true })).status).toBe(400);
    const processed = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?").bind(event.id).first<{ n: number }>();
    expect(processed!.n).toBe(0);
  });

  it("answers 503 while billing is off, so Stripe keeps the event", async () => {
    billingOn = false;
    expect((await deliver(stripe.event("invoice.paid", {}))).status).toBe(503);
  });

  it("acknowledges events it doesn't need, and subscriptions that aren't anyone's here", async () => {
    expect((await deliver(stripe.event("charge.succeeded", { id: "ch_1" }))).status).toBe(200);
    const sub = stripe.completeCheckout(
      (await stripe.createCheckoutSession(
        {
          customer: (await stripe.createCustomer({ email: "x@example.com", accountId: "acc_nobody" }, "k")).id,
          items: [{ price: PRICE_HOSTED, quantity: 1 }],
          successUrl: "",
          cancelUrl: "",
          accountId: "acc_nobody",
          metadata: { account_id: "acc_nobody" },
          automaticTax: true,
        },
        "k2",
      )).id,
    );
    for (const e of sub.events) expect((await deliver(e)).status).toBe(200);
  });
});

describe("the trial", () => {
  it("ends on day 15 for a trial with no subscription, through the partial index", async () => {
    const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${ENDED_TRIALS_SQL}`).bind(0, 100).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    expect(details).toContain("USING INDEX idx_tenants_trial_end (trial_ends_at<?)");
    expect(details).not.toMatch(/SCAN tenants(?! USING)/);

    const over = await customer({ trialEndsAt: clock.now - 1000 });
    const running = await customer({ trialEndsAt: clock.now + DAY });
    const paying = await customer({ trialEndsAt: clock.now - 1000, status: "active" });
    const ended = await endTrials(env.PLATFORM_DB, clock.now);
    expect(ended.map((t) => t.tenantId)).toContain(over.tenantId);
    expect(ended.map((t) => t.tenantId)).not.toContain(running.tenantId);
    expect(ended.map((t) => t.tenantId)).not.toContain(paying.tenantId);
    expect(await tenantRow(over.tenantId)).toMatchObject({ status: "suspended", billing_reason: "trial_ended", suspended_at: clock.now });
    expect(await tenantSees(over.slug)).toBe(503);

    const billing = await (await over.browser("/billing")).text();
    expect(billing).toContain("Your free trial ended on Nov 2, 2026.");
    await subscribe(over);
    expect(await tenantRow(over.tenantId)).toMatchObject({ status: "active", plan: "hosted", billing_reason: null });
  });
});

describe("review fixes (wave 3 review of #64)", () => {
  async function auditActions(accountId: string): Promise<string[]> {
    const rows = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE account_id = ? ORDER BY id").bind(accountId).all<{ action: string }>();
    return rows.results.map((r) => r.action);
  }

  it("never lets a stale copy saved last win: two deliveries for one account take turns", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    // Delivery A fetches the subscription while it is still active, then stalls.
    const staleEvent = stripe.update(sub.id, {});
    let release!: () => void;
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    stripe.onRetrieve = () => {
      stripe.onRetrieve = null;
      reached();
      return new Promise<void>((r) => (release = r));
    };
    const a = deliver(staleEvent);
    await atFetch;
    // Meanwhile Stripe cancels it, and delivery B arrives: the account is busy, so B is told to come back.
    const canceled = stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted");
    expect((await deliver(canceled)).status).toBe(409);
    release();
    expect((await a).status).toBe(200);
    // A fetched again after saving, saw the cancellation, and saved that.
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
    expect((await deliver(canceled)).status).toBe(200);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
  });

  it("changes nothing for a delivery that stalled past its lock, and runs it again later", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const staleEvent = stripe.update(sub.id, {});
    let release!: () => void;
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    stripe.onRetrieve = () => {
      stripe.onRetrieve = null;
      reached();
      return new Promise<void>((r) => (release = r));
    };
    const a = deliver(staleEvent);
    await atFetch;
    // A stalls for over a minute: its lock runs out, and B processes the cancellation.
    clock.now += 61_000;
    stripe.clock += 61;
    await deliverAll([stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted")]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
    // A wakes holding its active copy: its writes find the lock gone, so nothing changes, and Stripe retries it.
    release();
    expect((await a).status).toBe(500);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled" });
  });

  it("keeps one open Checkout per account, whichever button and however long apart", async () => {
    const c = await customer();
    await c.browser("/billing/checkout", { form: { plan: "hosted" } });
    clock.now += 61_000;
    await c.browser("/billing/checkout", { form: { plan: "hosted_fast" } });
    const [first, second] = [...stripe.sessions.values()];
    expect(first!.status).toBe("expired");
    expect(second!.status).toBe("open");
    // The first page can't take a payment any more.
    expect(() => stripe.completeCheckout(first!.id)).toThrow(/expired/);
    await deliverAll(stripe.completeCheckout(second!.id).events);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted_fast" });
  });

  it("cancels and refunds a second paid subscription, keeps the first, and tells the customer", async () => {
    const c = await customer();
    const first = await subscribe(c);
    // A second Checkout finished anyway (made before the expiry, say): Stripe has two active subscriptions.
    const customerId = [...stripe.customers.keys()][0]!;
    const extra = await stripe.createCheckoutSession(
      { ...[...stripe.sessions.values()][0]!.input, customer: customerId, items: [{ price: PRICE_HOSTED, quantity: 1 }, { price: PRICE_FAST, quantity: 1 }] },
      "second-tab",
    );
    const second = stripe.completeCheckout(extra.id);
    await deliverAll(second.events);
    expect(stripe.subscriptions.get(second.subscription.id)!.status).toBe("canceled");
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]!.reason).toBe("duplicate");
    expect(stripe.subscriptions.get(first.id)!.status).toBe("active");
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted" });
    expect(await auditActions(c.accountId)).toContain("billing.duplicate_refunded");
    expect(outbox.sent.filter((m) => m.subject === "We refunded a second OpenPing Hosted payment")).toHaveLength(1);
  });

  it("sends the customer to the invoice when the add-on's payment needs more, and adds it only once paid", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    stripe.declineNextUpdate = true;
    const res = await c.browser("/billing/add-fast", { form: {} });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Finish the payment");
    expect(page).not.toContain("on their way");
    expect(page).toMatch(/content="0;url=https:\/\/invoice\.stripe\.com\/i\/acct_fake\/test_in_fake/);
    // Stripe's events for the failed proration payment.
    await deliverAll([stripe.update(sub.id, {}), stripe.pendingPaymentFailed(sub.id)]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "active", plan: "hosted" });
    const mail = outbox.sent.at(-1)!;
    expect(mail.subject).toBe("Your 1-minute checks weren't added: the payment didn't go through");
    expect(mail.text).toContain("Your plan and your checks are unchanged.");
    expect(mail.text).not.toContain("keep running in the meantime");
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("checks are waiting on a payment");
    expect(billing).toContain("Pay the invoice");
    expect(billing).not.toContain("Add for $24 a year");

    await deliverAll(stripe.payPending(sub.id));
    expect(await tenantRow(c.tenantId)).toMatchObject({ plan: "hosted_fast" });
    expect(await (await c.browser("/billing")).text()).not.toContain("waiting on a payment");
  });

  it("drops the waiting add-on when Stripe lets it expire", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    stripe.declineNextUpdate = true;
    await c.browser("/billing/add-fast", { form: {} });
    await deliverAll([stripe.update(sub.id, {})]);
    expect(await (await c.browser("/billing")).text()).toContain("waiting on a payment");
    await deliverAll([stripe.expirePending(sub.id)]);
    const billing = await (await c.browser("/billing")).text();
    expect(billing).not.toContain("waiting on a payment");
    expect(billing).toContain("Add for $24 a year");
    expect(await tenantRow(c.tenantId)).toMatchObject({ plan: "hosted" });
  });

  it("emails a failed payment once, even when the event comes again before it was marked done", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const [updated, failed] = stripe.failRenewal(sub.id);
    await deliverAll([updated!, failed!]);
    const count = () => outbox.sent.filter((m) => m.subject === "Your OpenPing Hosted payment didn't go through").length;
    expect(count()).toBe(1);
    // A delivery that died after sending, before processed_at: Stripe delivers it again.
    await env.PLATFORM_DB.prepare("UPDATE stripe_events SET processed_at = NULL WHERE id = ?").bind(failed!.id).run();
    expect((await deliver(failed!)).status).toBe(200);
    expect(count()).toBe(1);
  });

  it("orders dunning by when invoices happened: a late payment_failed after a later invoice.paid shows nothing", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    const [, failed] = stripe.failRenewal(sub.id);
    const paid = stripe.pay(sub.id);
    await deliverAll(paid);
    await deliverAll([failed!]);
    const billing = await (await c.browser("/billing")).text();
    expect(billing).not.toContain("didn&#39;t go through");
    expect(outbox.sent.filter((m) => m.subject.includes("didn't go through"))).toHaveLength(0);
  });

  it("records subscriptions it can't place for the owner, and still stops a known one that is cancelled", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    // The price changed in Stripe's dashboard, then the subscription was cancelled.
    stripe.subscriptions.get(sub.id)!.items.data[0]!.price.id = "price_changedInDashboard";
    await deliverAll([stripe.update(sub.id, { status: "canceled" }, "customer.subscription.deleted")]);
    expect(await tenantRow(c.tenantId)).toMatchObject({ status: "suspended", billing_reason: "canceled", plan: "hosted" });
    expect(await auditActions(c.accountId)).toContain("billing.needs_attention");
    const detail = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE account_id = ? AND action = 'billing.needs_attention'").bind(c.accountId).first<{ detail: string }>();
    expect(JSON.parse(detail!.detail)).toMatchObject({ reason: "unknown_prices", subscription: sub.id, status: "canceled" });
  });

  it("ends trials past due even behind tenants being removed", async () => {
    const removed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await customer({ trialEndsAt: clock.now - 2000 });
      await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_state = 'deleting' WHERE id = ?").bind(r.tenantId).run();
      removed.push(r.tenantId);
    }
    const live = await customer({ trialEndsAt: clock.now - 1000 });
    const ended = await endTrials(env.PLATFORM_DB, clock.now, 2);
    expect(ended.map((t) => t.tenantId)).toContain(live.tenantId);
    for (const id of removed) expect((await tenantRow(id)).status).toBe("trial");
  });

  it("forgets old Stripe events and billing emails through their indexes", async () => {
    for (const sql of [OLD_EVENTS_SQL, OLD_EMAILS_SQL]) {
      const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(0).all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).join(" | ")).toMatch(/USING (COVERING )?INDEX idx_(stripe_events_received|billing_emails_sent)/);
    }
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("INSERT INTO stripe_events (id, type, created, received_at, processed_at) VALUES ('evt_old', 'x', 0, ?, ?)").bind(clock.now - 91 * DAY, clock.now - 91 * DAY),
      env.PLATFORM_DB.prepare("INSERT INTO stripe_events (id, type, created, received_at, processed_at) VALUES ('evt_new', 'x', 0, ?, ?)").bind(clock.now - DAY, clock.now - DAY),
      env.PLATFORM_DB.prepare("INSERT INTO billing_emails (key, sent_at) VALUES ('old', ?), ('new', ?)").bind(clock.now - 91 * DAY, clock.now - DAY),
    ]);
    await env.PLATFORM_DB.batch(billingRecordsCleanup(env.PLATFORM_DB, clock.now));
    const events = await env.PLATFORM_DB.prepare("SELECT id FROM stripe_events WHERE id IN ('evt_old', 'evt_new')").all<{ id: string }>();
    expect(events.results.map((r) => r.id)).toEqual(["evt_new"]);
    const emails = await env.PLATFORM_DB.prepare("SELECT key FROM billing_emails WHERE key IN ('old', 'new')").all<{ key: string }>();
    expect(emails.results.map((r) => r.key)).toEqual(["new"]);
  });
});

describe("launch pricing: packs and the fast checks add-on (D13)", () => {
  async function packs(id: string) {
    return env.PLATFORM_DB.prepare("SELECT plan, monitor_packs, fast_packs FROM tenants WHERE id = ?").bind(id).first();
  }
  const post = (c: Awaited<ReturnType<typeof customer>>, kind: string, quantity: number) =>
    c.browser("/billing/packs", { form: { kind, quantity: String(quantity) } });
  const done = (res: Response) => res.headers.get("location");
  async function attention(accountId: string): Promise<string[]> {
    const rows = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE account_id = ? AND action = 'billing.needs_attention' ORDER BY id")
      .bind(accountId)
      .all<{ detail: string }>();
    return rows.results.map((r) => JSON.parse(r.detail).problems ?? JSON.parse(r.detail).reason);
  }

  it("prices the plan, the add-on and the packs as decided", () => {
    expect(PRICE_TEXT).toEqual({ hosted: "$24 a year", fast: "$24 a year", both: "$48 a year", monitorPack: "$24 a year", fastPack: "$36 a year" });
    expect(yearlyTotal("hosted", { monitors: 0, fast_monitors: 0 })).toBe(24);
    expect(yearlyTotal("hosted_fast", { monitors: 4, fast_monitors: 3 })).toBe(24 + 24 + 4 * 24 + 3 * 36);
    expect(TRIAL_DAYS).toBe(30);
  });

  it("reads packs from the items' quantities, capped, and fast packs only with the add-on", () => {
    const config = { priceMonitorPack: PRICE_MONITOR_PACK, priceFastPack: PRICE_FAST_PACK };
    const item = (price: string, quantity?: number) => ({ price: { id: price }, quantity });
    expect(packsForItems([item(PRICE_HOSTED), item(PRICE_MONITOR_PACK, 2)], "hosted", config)).toEqual({ packs: { monitors: 2, fast_monitors: 0 }, problems: [] });
    expect(packsForItems([item(PRICE_MONITOR_PACK, 6), item(PRICE_FAST_PACK, 5)], "hosted_fast", config)).toEqual({
      packs: { monitors: 4, fast_monitors: 3 },
      problems: ["monitor_packs_over_cap:6", "fast_packs_over_cap:5"],
    });
    expect(packsForItems([item(PRICE_FAST_PACK, 1)], "hosted", config)).toEqual({ packs: { monitors: 0, fast_monitors: 0 }, problems: ["fast_packs_without_add_on:1"] });
    // A quantity Stripe leaves out is 1.
    expect(packsForItems([item(PRICE_MONITOR_PACK)], "hosted", config).packs.monitors).toBe(1);
  });

  it("checks out with packs, held to their caps and to the plan they are sold with", async () => {
    const c = await customer();
    const page = await (await c.browser("/billing")).text();
    expect(page).toContain("More than 20 monitors?");
    expect(page).toContain('<option value="4">100 more monitors, $96 a year</option>');
    await c.browser("/billing/checkout", { form: { plan: "hosted", monitor_packs: "9", fast_packs: "2" } });
    expect([...stripe.sessions.values()].at(-1)!.input.items).toEqual([
      { price: PRICE_HOSTED, quantity: 1 },
      { price: PRICE_MONITOR_PACK, quantity: 4 },
    ]);
    await c.browser("/billing/checkout", { form: { plan: "hosted_fast", monitor_packs: "1", fast_packs: "2" } });
    const session = [...stripe.sessions.values()].at(-1)!;
    expect(session.input.items).toEqual([
      { price: PRICE_HOSTED, quantity: 1 },
      { price: PRICE_FAST, quantity: 1 },
      { price: PRICE_MONITOR_PACK, quantity: 1 },
      { price: PRICE_FAST_PACK, quantity: 2 },
    ]);
    await deliverAll(stripe.completeCheckout(session.id).events);
    expect(await packs(c.tenantId)).toEqual({ plan: "hosted_fast", monitor_packs: 1, fast_packs: 2 });
    // The tenant's next call carries the final numbers: it never adds them up itself.
    expect(await tenantSees(c.slug)).toMatchObject({ plan: "hosted_fast", limits: { monitors: 45, fastMonitors: 15, minIntervalMinutes: 1 } });
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Renews on Nov 2, 2027 for $144 a year.");
    expect(billing).toContain("Packs: 1 monitor pack, 2 fast monitor packs.");
  });

  it("adds and removes monitor packs: more is charged now, fewer credited to the renewal, nothing deleted", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    expect(await (await c.browser("/billing")).text()).toContain("Add 25 monitors: $24 a year");

    // One pack: a new line, quantity 1, charged at once and only if paid.
    expect(done(await post(c, "monitors", 1))).toBe("/billing?done=packs-added");
    expect(stripe.addedItems).toEqual([{ subscription: sub.id, price: PRICE_MONITOR_PACK, quantity: 1 }]);
    // The limits follow the webhook, never the post.
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 0 });
    await deliverAll([stripe.updated(sub.id)]);
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 1 });
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 45 } });

    // A second: the same line, quantity 2, charged now.
    expect(done(await post(c, "monitors", 2))).toBe("/billing?done=packs-added");
    const line = sub.items.data.find((i) => i.price.id === PRICE_MONITOR_PACK)!;
    expect(stripe.itemChanges.at(-1)).toEqual({ item: line.id, quantity: 2, proration: "always_invoice" });
    await deliverAll([stripe.updated(sub.id)]);
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 70 } });
    // Asked again for the same total: nothing changes.
    expect(done(await post(c, "monitors", 2))).toBe("/billing?done=packs-unchanged");

    // Fewer: applies at once, the unused part credited to the next invoice.
    expect(done(await post(c, "monitors", 1))).toBe("/billing?done=packs-removed");
    expect(stripe.itemChanges.at(-1)).toEqual({ item: line.id, quantity: 1, proration: "create_prorations" });
    expect(done(await post(c, "monitors", 0))).toBe("/billing?done=packs-removed");
    expect(stripe.calls.at(-1)?.method).toBe("deleteSubscriptionItem");
    expect(stripe.credits).toHaveLength(2);
    await deliverAll([stripe.updated(sub.id)]);
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 0 });
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 20 } });
    const audit = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE tenant_id = ? AND action = 'billing.changed' ORDER BY id")
      .bind(c.tenantId)
      .all<{ detail: string }>();
    expect(audit.results.map((r) => JSON.parse(r.detail).to)).toEqual([
      "active/hosted",
      "active/hosted (+1 monitor packs)",
      "active/hosted (+2 monitor packs)",
      "active/hosted",
    ]);
  });

  it("refuses what isn't sold: past a cap, fast packs without the add-on, nonsense", async () => {
    const c = await customer();
    await subscribe(c);
    expect((await post(c, "monitors", 5)).headers.get("location")).toBe("/billing?done=packs-at-most");
    expect(done(await post(c, "fast_monitors", 1))).toBe("/billing?done=needs-fast");
    expect((await post(c, "storage", 1)).status).toBe(400);
    expect((await c.browser("/billing/packs", { form: { kind: "monitors", quantity: "-1" } })).status).toBe(400);
    expect(stripe.addedItems).toEqual([]);
    // A trial has no subscription to add to.
    const trial = await customer();
    expect(done(await post(trial, "monitors", 1))).toBe("/billing?done=no-plan");
  });

  it("adds fast monitor packs to the add-on, and shows the most a plan can have", async () => {
    const c = await customer();
    const sub = await subscribe(c, "hosted_fast");
    for (const n of [1, 2, 3]) {
      expect(done(await post(c, "fast_monitors", n))).toBe("/billing?done=packs-added");
      await deliverAll([stripe.updated(sub.id)]);
    }
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 20, fastMonitors: 20 } });
    const upgrade = await (await c.browser("/billing/upgrade?need=fast_monitors")).text();
    expect(upgrade).toContain("You have 3 fast monitor packs, so 20 fast monitors in all.");
    expect(upgrade).toContain("That's the most a plan can have.");
    expect(upgrade).not.toContain("Add 5 fast monitors");
    expect(upgrade).toContain("Remove a fast monitor pack");
  });

  it("leads the upgrade page with what lifts the limit the tenant named", async () => {
    const c = await customer();
    await subscribe(c);
    const lead = (page: string) => /<div class="offer lead-offer"><h3>([^<]+)<\/h3>/.exec(page)?.[1];
    expect(lead(await (await c.browser("/billing/upgrade?need=monitors")).text())).toBe("More monitors");
    expect(lead(await (await c.browser("/billing/upgrade?need=fast_monitors")).text())).toBe("1‑minute checks");
    expect(lead(await (await c.browser("/billing/upgrade?need=interval")).text())).toBe("1‑minute checks");
    expect(lead(await (await c.browser("/billing/upgrade?need=bogus")).text())).toBe("1‑minute checks");
    // On a trial, more monitors means subscribing; faster checks lead with the add-on.
    const trial = await customer();
    const page = await (await trial.browser("/billing/upgrade?need=monitors")).text();
    expect(page.indexOf("Subscribe for $24 a year")).toBeLessThan(page.indexOf("1‑minute checks: $48"));
  });

  it("waits on a declined card like the add-on does, and allows no second change meanwhile", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    stripe.declineNextUpdate = true;
    const res = await post(c, "monitors", 1);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("before extra monitors can be added");
    await deliverAll([stripe.updated(sub.id), stripe.pendingPaymentFailed(sub.id)]);
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 0 });
    const mail = outbox.sent.at(-1)!;
    expect(mail.subject).toBe("Your extra monitors weren't added: the payment didn't go through");
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Extra monitors are waiting on a payment");
    expect(billing).not.toContain("Add 25 monitors");
    // A second change waits for the first.
    expect(done(await post(c, "monitors", 2))).toBe("/billing?done=change-pending");
    expect(done(await c.browser("/billing/add-fast", { form: {} }))).toBe("/billing?done=change-pending");
    // Paid: Stripe applies it, and the limits follow.
    await deliverAll(stripe.payPending(sub.id));
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 1 });
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 45 } });
    expect(await (await c.browser("/billing")).text()).not.toContain("waiting on a payment");
  });

  it("ends on what Stripe has now, whatever order the quantity changes' events arrive in", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    await post(c, "monitors", 1);
    const first = stripe.updated(sub.id);
    await post(c, "monitors", 3);
    const second = stripe.updated(sub.id);
    // The later change's event first, then the earlier one's stale copy.
    await deliverAll([second, first]);
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 3 });
    // And a removal whose event comes before the add's.
    await post(c, "monitors", 2);
    const removal = stripe.updated(sub.id);
    await deliverAll([removal, first]);
    expect(await packs(c.tenantId)).toMatchObject({ monitor_packs: 2 });
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 70 } });
  });

  it("takes turns with the webhook and other changes through the account's billing lock", async () => {
    const c = await customer();
    const sub = await subscribe(c);
    // A delivery holds the account (it stalls fetching the subscription).
    let release!: () => void;
    let reached!: () => void;
    const atFetch = new Promise<void>((r) => (reached = r));
    stripe.onRetrieve = () => {
      stripe.onRetrieve = null;
      reached();
      return new Promise<void>((r) => (release = r));
    };
    const delivery = deliver(stripe.updated(sub.id));
    await atFetch;
    // A pack change meanwhile is told to try again, and changes nothing at Stripe.
    const busy = await post(c, "monitors", 1);
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain("Your billing is being updated right now.");
    expect(stripe.addedItems).toEqual([]);
    release();
    expect((await delivery).status).toBe(200);
    expect(done(await post(c, "monitors", 1))).toBe("/billing?done=packs-added");
  });

  it("holds a subscription changed in Stripe's dashboard to the caps, and tells the owner", async () => {
    const c = await customer();
    const sub = await subscribe(c, "hosted_fast");
    await post(c, "monitors", 1);
    await post(c, "fast_monitors", 1);
    // Someone sets the quantities past the caps in the dashboard...
    for (const item of stripe.subscriptions.get(sub.id)!.items.data) {
      if (item.price.id === PRICE_MONITOR_PACK) item.quantity = 7;
      if (item.price.id === PRICE_FAST_PACK) item.quantity = 4;
    }
    await deliverAll([stripe.updated(sub.id)]);
    expect(await packs(c.tenantId)).toEqual({ plan: "hosted_fast", monitor_packs: 4, fast_packs: 3 });
    expect(await tenantSees(c.slug)).toMatchObject({ limits: { monitors: 120, fastMonitors: 20 } });
    // ...then takes the add-on off, leaving a fast pack: it counts for nothing, nothing is deleted.
    const s = stripe.subscriptions.get(sub.id)!;
    s.items.data = s.items.data.filter((i) => i.price.id !== PRICE_FAST);
    await deliverAll([stripe.updated(sub.id)]);
    expect(await packs(c.tenantId)).toEqual({ plan: "hosted", monitor_packs: 4, fast_packs: 0 });
    expect(await tenantSees(c.slug)).toMatchObject({ plan: "hosted", limits: { monitors: 120, fastMonitors: 0, minIntervalMinutes: 12 } });
    expect(await attention(c.accountId)).toEqual([
      "monitor_packs_over_cap:7 fast_packs_over_cap:4",
      "monitor_packs_over_cap:7 fast_packs_without_add_on:4",
    ]);
  });

  it("shows the plan, its packs and what the tenant uses, over a limit after a downgrade too", async () => {
    const c = await customer();
    const sub = await subscribe(c, "hosted_fast");
    await post(c, "monitors", 1);
    await deliverAll([stripe.updated(sub.id)]);
    await env.PLATFORM_DB.prepare(
      "INSERT INTO tenant_usage (tenant_id, monitors, fast_monitors, status_pages, channels, counted_at, reported_at) VALUES (?, 31, 7, 1, 2, ?, ?)",
    )
      .bind(c.tenantId, clock.now, clock.now)
      .run();
    const billing = await (await c.browser("/billing")).text();
    expect(billing).toContain("Hosted with 1‑minute checks: 45 monitors, 2 status pages, every alert channel; 5 of the monitors checked as often as every minute");
    expect(billing).toMatch(/<strong>Monitors<\/strong><\/span><span class="value">31 of 45<\/span>/);
    expect(billing).toMatch(/<strong>Fast monitors<\/strong>.*?<span class="value">7 of 5 <span class="over">over<\/span><\/span>/);
    expect(billing).toContain("Nothing in your OpenPing is ever deleted");
    // The account page shows the same.
    expect(await (await c.browser("/account")).text()).toContain("31 of 45");
  });

  it("ends a trial after its 30 days, not before", async () => {
    const day29 = await customer({ trialEndsAt: clock.now + DAY });
    const ended = await customer({ trialEndsAt: clock.now - 1 });
    const swept = (await endTrials(env.PLATFORM_DB, clock.now)).map((t) => t.tenantId);
    expect(swept).toContain(ended.tenantId);
    expect(swept).not.toContain(day29.tenantId);
  });
});
