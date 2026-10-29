import { Hono, type Context } from "hono";
import {
  HANDOFF_QUERY_PARAM,
  importHandoffPublicKey,
  verifyHandoffToken,
  type HandoffClaims,
  type HandoffError,
  type TenantProps,
} from "../../shared/hosted-contract";
import type { AppEnv } from "../types";
import { hitRateLimit } from "../db/rate-limit";
import { recordHandoffNonce } from "../db/handoff-nonces";
import { recordSupportActivity } from "../lib/support";
import { setSetting } from "../db/settings";
import { createSession, endCurrentSession } from "../lib/sessions";
import { hostedProps } from "../lib/hosted";
import { renderPlainPage } from "../lib/plain-page";
import { afterSignInPath } from "./app-signin";

/**
 * GET /auth/hosted?t=<token>: the OpenPing Hosted sign-in hand-off
 * (docs/hosted/CONTRACT.md, section 7). The platform signs the customer in,
 * then redirects here with a single-use, 60-second Ed25519 token; this checks
 * it and starts the same session every other sign-in starts.
 *
 * Hosted mode only. On a plain install the route passes through to whatever
 * answered the path before (the app's not-found page).
 */
export const hostedAuth = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const PER_IP_LIMIT = 30;
const GLOBAL_LIMIT = 600;
const UNKNOWN_IP = "unknown";
/** A support sign-in (the owner helping a customer) lasts an hour, not the usual 30 days. */
export const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000;

type Refusal = HandoffError | "rate_limited" | "misconfigured" | "audit_failed";
type Outcome = { ok: true; claims: HandoffClaims } | { ok: false; reason: Refusal };

const REFUSAL_STATUS: Partial<Record<Refusal, 429 | 503>> = {
  rate_limited: 429,
  misconfigured: 503,
  audit_failed: 503,
};

hostedAuth.get("/", async (c, next) => {
  const props = hostedProps(c);
  if (!props) return next();

  // The token is in this URL: keep it out of every Referer and every cache.
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");

  const outcome = await handOff(c, props);
  if (!outcome.ok) {
    // The reason is for the logs only, never the visitor.
    console.warn(`[hosted] sign-in hand-off refused: ${outcome.reason}`);
    return c.html(handoffFailedPage(props.tenant.urls.signIn), REFUSAL_STATUS[outcome.reason] ?? 400);
  }
  // A relative redirect to the dashboard (or on to the Android app, when the
  // sign-in started there): the token is gone from the address.
  return c.redirect(afterSignInPath(c), 302);
});

async function handOff(c: Ctx, props: TenantProps): Promise<Outcome> {
  const ip = c.req.header("cf-connecting-ip") ?? UNKNOWN_IP;
  for (const [key, limit] of [
    [`handoff:ip:${ip}`, PER_IP_LIMIT],
    ["handoff:global", GLOBAL_LIMIT],
  ] as const) {
    const hit = await hitRateLimit(c.env, key, limit);
    if (!hit.allowed) {
      c.header("Retry-After", String(hit.retryAfterSeconds));
      return { ok: false, reason: "rate_limited" };
    }
  }

  const tokens = c.req.queries(HANDOFF_QUERY_PARAM) ?? [];
  if (tokens.length !== 1 || !tokens[0]) return { ok: false, reason: "malformed" };

  let publicKey: CryptoKey;
  try {
    publicKey = await importHandoffPublicKey(c.env.HANDOFF_PUBLIC_KEY ?? "");
  } catch {
    console.error("[hosted] HANDOFF_PUBLIC_KEY is missing or not a 32-byte base64url Ed25519 key");
    return { ok: false, reason: "misconfigured" };
  }

  // 1. Format, signature, issuer, audience (this tenant) and times.
  const verified = await verifyHandoffToken(tokens[0], publicKey, {
    tenantId: props.tenant.id,
    now: Date.now(),
  });
  if (!verified.ok) return { ok: false, reason: verified.error };
  const { claims } = verified;

  // 2. Single use, only once the token is known to be genuine.
  if (!(await recordHandoffNonce(c.env, claims.nonce, claims.exp))) return { ok: false, reason: "replayed" };

  // 3. Record it with the platform. A support sign-in is always audited, so
  // one that can't be recorded doesn't happen; a customer's still signs in.
  const support = claims.role === "support";
  try {
    await props.platform.audit({
      action: "session.created",
      actor: support ? "support" : "customer",
      detail: { method: "handoff", role: claims.role, account: claims.sub },
      at: Date.now(),
    });
  } catch (error) {
    console.error("[hosted] could not audit a hand-off sign-in", error);
    if (support) return { ok: false, reason: "audit_failed" };
  }

  // The customer's account email is this OpenPing's admin email: the weekly
  // summary and the monthly report go there (through the platform's mail).
  // Kept in step on every sign-in, so a change on the platform reaches it.
  // Before the session, and never fatal: a failed write can't leave a
  // half-made sign-in; the reports just keep the address they had.
  if (!support) {
    await setSetting(c.env, "admin_email", claims.email).catch((error: unknown) =>
      console.error("[hosted] could not store the account email for reports", error),
    );
  }

  // 4. The normal session, rotated: whatever session this browser had ends.
  await endCurrentSession(c);
  if (support) {
    await createSession(c, claims.email, "hosted_support", SUPPORT_SESSION_TTL_MS);
    await recordSupportActivity(c.env, { kind: "signed_in", identity: claims.email });
  }
  else await createSession(c, claims.email, "hosted");
  return { ok: true, claims };
}

/**
 * The one page every refused hand-off shows (contract, section 7): plain, no
 * script, styled like the app, with a way back to the platform's sign-in.
 */
export function handoffFailedPage(signInUrl: string): string {
  return renderPlainPage({
    title: "Sign-in link expired",
    heading: "This sign-in link has expired",
    body: ["Sign-in links from OpenPing Hosted work once, for a minute. Sign in again to get a new one."],
    action: { href: signInUrl, label: "Sign in again" },
    fine: "Your monitors keep running while you're signed out.",
  });
}
