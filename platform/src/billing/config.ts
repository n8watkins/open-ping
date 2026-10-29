/**
 * Billing's settings, checked once: the Stripe keys, the four prices, Stripe
 * Tax, and test mode. Until every one is set, billing is off: the account
 * page says paid plans open soon, and the webhook answers 503.
 *
 * The prices (decision D13), each a yearly recurring Price in Stripe, by id
 * from the env and never written here:
 *   STRIPE_PRICE_HOSTED        the plan, $24 a year, quantity 1
 *   STRIPE_PRICE_FAST          the fast checks add-on, $24 a year, quantity 1
 *   STRIPE_PRICE_MONITOR_PACK  25 more monitors, $24 a year per pack, quantity 1 to 4
 *   STRIPE_PRICE_FAST_PACK     5 more fast monitors, $36 a year per pack, quantity 1 to 3
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
  /** STRIPE_PRICE_FAST: the fast checks add-on's Price ($24 a year: 1-minute checks on 5 monitors). */
  priceFast: string;
  /** STRIPE_PRICE_MONITOR_PACK: a pack of 25 more monitors ($24 a year each). */
  priceMonitorPack: string;
  /** STRIPE_PRICE_FAST_PACK: a pack of 5 more fast monitors ($36 a year each, with the add-on). */
  priceFastPack: string;
  /** STRIPE_TAX: Stripe Tax in Checkout, on unless "off". */
  automaticTax: boolean;
  /** STRIPE_PORTAL_CONFIGURATION: a Customer Portal configuration (bpc_...), or the account's default. */
  portalConfiguration: string | null;
  live: boolean;
}

/** The four prices billing sells, as BillingConfig names them. */
export type PriceKey = "priceHosted" | "priceFast" | "priceMonitorPack" | "priceFastPack";

export type BillingSetup = { ok: true; config: BillingConfig; stripe: StripeApi } | { ok: false; missing: string[] };

const PRICE_ID = /^price_[A-Za-z0-9]{6,}$/;

const PRICE_VARS: readonly [PriceKey, "STRIPE_PRICE_HOSTED" | "STRIPE_PRICE_FAST" | "STRIPE_PRICE_MONITOR_PACK" | "STRIPE_PRICE_FAST_PACK"][] = [
  ["priceHosted", "STRIPE_PRICE_HOSTED"],
  ["priceFast", "STRIPE_PRICE_FAST"],
  ["priceMonitorPack", "STRIPE_PRICE_MONITOR_PACK"],
  ["priceFastPack", "STRIPE_PRICE_FAST_PACK"],
];

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
  // Each price set, a Price id, and none the same as another (one Price can't be two things).
  const prices = {} as Record<PriceKey, string>;
  const seen = new Set<string>();
  for (const [field, name] of PRICE_VARS) {
    const value = env[name]?.trim() ?? "";
    prices[field] = value;
    if (!PRICE_ID.test(value) || seen.has(value)) missing.push(name);
    seen.add(value);
  }
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    stripe: makeApi(key),
    config: {
      webhookSecret,
      ...prices,
      automaticTax: env.STRIPE_TAX !== "off",
      portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION?.trim() || null,
      live,
    },
  };
}
