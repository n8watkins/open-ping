/**
 * Billing's settings, checked once: the Stripe keys, the two prices, Stripe
 * Tax, and test mode. Until every one is set, billing is off: the account
 * page says paid plans open soon, and the webhook answers 503.
 *
 * Test mode only, unless the owner says otherwise: with STRIPE_MODE unset or
 * "test", a live key (sk_live_, rk_live_) is refused and so is any event
 * whose `livemode` is true, so a key pasted into the wrong secret can never
 * charge anyone. Going live is setting STRIPE_MODE to "live" with live keys
 * and prices (build plan, owner action O8).
 */

import type { PlatformEnv } from "../env";
import { HttpStripeApi, type StripeApi } from "./stripe";

export interface BillingConfig {
  /** STRIPE_WEBHOOK_SECRET: the endpoint's whsec_... signing secret. */
  webhookSecret: string;
  /** STRIPE_PRICE_HOSTED: the yearly plan's Price ($24 a year). */
  priceHosted: string;
  /** STRIPE_PRICE_FAST: the 1-minute checks add-on's Price ($12 a year). */
  priceFast: string;
  /** STRIPE_TAX: Stripe Tax in Checkout, on unless "off". */
  automaticTax: boolean;
  /** STRIPE_PORTAL_CONFIGURATION: a Customer Portal configuration (bpc_...), or the account's default. */
  portalConfiguration: string | null;
  live: boolean;
}

export type BillingSetup = { ok: true; config: BillingConfig; stripe: StripeApi } | { ok: false; missing: string[] };

const PRICE_ID = /^price_[A-Za-z0-9]{6,}$/;

export function billingSetup(env: PlatformEnv, makeApi: (secretKey: string) => StripeApi = (key) => new HttpStripeApi(key)): BillingSetup {
  const missing: string[] = [];
  const live = env.STRIPE_MODE === "live";
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const keyMode = /^(sk|rk)_(test|live)_/.exec(key)?.[2];
  if (!key) missing.push("STRIPE_SECRET_KEY");
  else if (!keyMode) missing.push("STRIPE_SECRET_KEY (not a Stripe secret or restricted key)");
  else if ((keyMode === "live") !== live) missing.push(live ? "STRIPE_SECRET_KEY (a test key, but STRIPE_MODE is live)" : "STRIPE_SECRET_KEY (a live key: set STRIPE_MODE to live to use it)");
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookSecret.startsWith("whsec_")) missing.push("STRIPE_WEBHOOK_SECRET");
  const priceHosted = env.STRIPE_PRICE_HOSTED?.trim() ?? "";
  const priceFast = env.STRIPE_PRICE_FAST?.trim() ?? "";
  if (!PRICE_ID.test(priceHosted)) missing.push("STRIPE_PRICE_HOSTED");
  if (!PRICE_ID.test(priceFast) || priceFast === priceHosted) missing.push("STRIPE_PRICE_FAST");
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    stripe: makeApi(key),
    config: {
      webhookSecret,
      priceHosted,
      priceFast,
      automaticTax: env.STRIPE_TAX !== "off",
      portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION?.trim() || null,
      live,
    },
  };
}
