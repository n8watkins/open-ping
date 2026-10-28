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
import { escapeHtml } from "../notifications/email-layout";

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
  // A relative redirect to the dashboard: the token is gone from the address.
  return c.redirect("/", 302);
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
  const href = escapeHtml(signInUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b1220" />
    <meta name="color-scheme" content="dark" />
    <meta name="robots" content="noindex" />
    <title>Sign-in link expired | OpenPing</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style>
      :root {
        --canvas: #0b1220;
        --surface: #111b2e;
        --line: #1f2c44;
        --ink: #e6edf6;
        --ink-muted: #9fb0c5;
        --ink-faint: #8595ad;
        --accent: #6d8bff;
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 1.5rem 1rem;
        background-color: var(--canvas);
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      main { width: 100%; max-width: 24rem; }
      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin: 0 0 2rem;
        font-size: 1.125rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--ink);
      }
      .brand svg { width: 28px; height: 28px; }
      .brand .ping { color: var(--accent); }
      .card {
        padding: 1.5rem;
        border: 1px solid var(--line);
        border-radius: 0.875rem;
        background-color: var(--surface);
        text-align: center;
      }
      h1 { margin: 0; font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 0.75rem 0 0; font-size: 0.875rem; line-height: 1.6; color: var(--ink-muted); }
      .button {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 2.75rem;
        margin-top: 1.5rem;
        border-radius: 0.5rem;
        background-color: var(--ink);
        color: var(--canvas);
        font-size: 0.875rem;
        font-weight: 600;
        text-decoration: none;
      }
      .button:hover { opacity: 0.9; }
      .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .fine { margin-top: 1.5rem; font-size: 0.75rem; color: var(--ink-faint); text-align: center; }
    </style>
  </head>
  <body>
    <main>
      <p class="brand" aria-label="OpenPing">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#111b2e" />
          <circle cx="16" cy="16" r="4" fill="#6d8bff" />
          <circle cx="16" cy="16" r="9" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.5" />
          <circle cx="16" cy="16" r="13" fill="none" stroke="#6d8bff" stroke-width="1.5" opacity="0.2" />
        </svg>
        <span>Open<span class="ping">Ping</span></span>
      </p>
      <div class="card">
        <h1>This sign-in link has expired</h1>
        <p>Sign-in links from OpenPing Hosted work once, for a minute. Sign in again to get a new one.</p>
        <a class="button" href="${href}">Sign in again</a>
      </div>
      <p class="fine">Your monitors keep running while you're signed out.</p>
    </main>
  </body>
</html>
`;
}
