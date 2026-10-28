/**
 * What the landing page offers for OpenPing Hosted, and the one switch that
 * opens it: the HOSTED_SIGNUP_URL wrangler var (docs/HOSTED_BUILD_PLAN.md, D1).
 *
 * Unset (the default, and every install but the canonical one), Hosted is a
 * waitlist and the landing page reads as it always has. Set to the platform's
 * sign-up page (for example `https://app.<domain>/sign-up`), the landing page
 * offers the free trial instead: the Worker reports the URL in
 * `/api/auth/status` and writes the launch title into the page's head.
 *
 * Pure: shared by the Worker and the client.
 */

import { PLAN_LIMITS } from "./hosted-contract";

/** The plan's prices in US dollars a year (docs/HOSTED_PLAN.md, decision D5). */
export const HOSTED_PRICE_YEARLY = 24;
export const HOSTED_FAST_CHECKS_YEARLY = 12;

/** Length of the free trial, in days; the platform's TRIAL_DAYS (platform/src/provisioning.ts). */
export const HOSTED_TRIAL_DAYS = 14;

/** Where Hosted customers write for help (owner decision O4). */
export const HOSTED_SUPPORT_EMAIL = "support@n8builds.dev";

/** What the trial and the paid plan include, as the platform enforces them. */
export const HOSTED_TRIAL_LIMITS = PLAN_LIMITS.trial;
export const HOSTED_PLAN_LIMITS = PLAN_LIMITS.hosted;

/** Hosts a plain-http sign-up URL may point at: a local platform in development only. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The sign-up URL from the HOSTED_SIGNUP_URL var, or null when Hosted isn't
 * open: unset, blank, not an absolute URL, or not https (plain http only for
 * a local platform). A malformed value never half-opens the offer.
 */
export function parseHostedSignupUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password) return null;
  return url.href;
}

/**
 * Where an existing Hosted customer signs in: the platform's `/sign-in`
 * page beside its sign-up page (platform/src/account-routes.ts).
 */
export function hostedSignInUrl(signupUrl: string): string {
  return new URL("/sign-in", signupUrl).href;
}

/** The landing page's title and description, for the waitlist (closed) or the launch (open). */
export function landingMeta(hostedOpen: boolean): { title: string; description: string } {
  if (!hostedOpen) {
    return {
      title: "OpenPing: uptime monitoring on your own Cloudflare",
      description:
        "Open-source uptime checks, status pages and alerts with schedules that know when an app is meant to be asleep. " +
        "Free in your own Cloudflare account, or join the waitlist for OpenPing Hosted.",
    };
  }
  return {
    title: "OpenPing: uptime monitoring that knows your hours",
    description:
      "Open-source uptime checks, status pages and alerts with schedules that know when an app is meant to be asleep. " +
      `Free in your own Cloudflare account, or OpenPing Hosted for $${HOSTED_PRICE_YEARLY} a year, ` +
      `with a ${HOSTED_TRIAL_DAYS}-day free trial and no card.`,
  };
}
