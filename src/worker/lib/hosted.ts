import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isAppUserAgent } from "../../shared/native-app";
import {
  HOSTED_CONTRACT_VERSION,
  HOSTED_ERRORS,
  isHostedMode,
  isInternalPath,
  isTenantId,
  isTenantProps,
  type PlatformCapability,
  type TenantInfo,
  type TenantProps,
} from "../../shared/hosted-contract";
import type { AppEnv, Env } from "../types";
import { schemaIsCurrent } from "./migrate";
import { platformTransport } from "../notifications/mail";

/**
 * Hosted mode: OpenPing running as a customer's user Worker in the OpenPing
 * Hosted dispatch namespace (docs/hosted/CONTRACT.md, section 2).
 *
 * Everything here is gated on HOSTED_MODE being exactly "1". A plain install
 * never reads props and never takes any of these paths, so it behaves exactly
 * as it did before hosted mode existed.
 */

type Ctx = Context<AppEnv>;

/** True when this Worker runs in hosted mode (the HOSTED_MODE var is "1"). */
export function hostedMode(env: Pick<Env, "HOSTED_MODE">): boolean {
  return isHostedMode(env.HOSTED_MODE);
}

/** This request's props from the platform; set only in hosted mode, by hostedGate. */
export function hostedProps(c: Ctx): TenantProps | undefined {
  return c.get("hosted");
}

/** The props the runtime passed this call (`ctx.props`), or undefined when there is no context. */
function contextProps(c: Ctx): unknown {
  try {
    return (c.executionCtx as ExecutionContext<unknown>).props;
  } catch {
    // Hono throws when the app runs without an ExecutionContext.
    return undefined;
  }
}

/** The stand-in platform capability for local development: it logs and sends nothing. */
const devPlatform: PlatformCapability = {
  async sendEmail(message) {
    console.log(`[hosted dev] sendEmail (${message.category}) to ${message.to.length} recipient(s): not sent`);
    return { ok: false, error: "email_unavailable", message: "Email isn't sent in local development." };
  },
  async reportUsage(counts) {
    console.log("[hosted dev] reportUsage", counts);
  },
  async audit(event) {
    console.log(`[hosted dev] audit ${event.action} by ${event.actor}`, event.detail ?? {});
  },
};

/**
 * The development seam (contract, "Local development"): under `npm run dev`
 * there is no dispatcher to pass props, so the HOSTED_DEV_TENANT var (TenantInfo
 * JSON) stands in for `props.tenant`, with a platform that only logs.
 *
 * `dev` is Vite's compile-time `import.meta.env.DEV`, which a production build
 * replaces with false, so a deployed Worker never reaches this, whatever its
 * vars say. Nothing a request carries (no header, cookie or query) can set props.
 */
export function devTenantProps(env: Pick<Env, "HOSTED_DEV_TENANT">, dev: boolean): TenantProps | null {
  if (!dev || !env.HOSTED_DEV_TENANT) return null;
  let tenant: TenantInfo;
  try {
    tenant = JSON.parse(env.HOSTED_DEV_TENANT) as TenantInfo;
  } catch {
    return null;
  }
  const props = {
    contract: HOSTED_CONTRACT_VERSION,
    invocation: "public",
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant,
    platform: devPlatform,
  } satisfies TenantProps;
  return isTenantProps(props) ? props : null;
}

/**
 * The hosted-mode gate, first after the security headers. In hosted mode every
 * call must carry props this bundle understands, for the tenant in TENANT_ID;
 * anything else answers 503 and does nothing else (contract, section 3). The
 * props are kept on this request's context only. A plain install passes
 * straight through without reading props.
 */
export function hostedGate({ dev }: { dev: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hostedMode(c.env)) return next();
    const tenantId = c.env.TENANT_ID;
    if (!isTenantId(tenantId)) {
      console.error("[hosted] TENANT_ID is missing or not a tenant id");
      return c.json({ error: HOSTED_ERRORS.unavailable }, 503);
    }
    const fromRuntime = contextProps(c);
    // Outside a dispatch namespace the runtime passes empty props, so only a
    // development build falls back to the dev seam.
    const props = isTenantProps(fromRuntime, tenantId) ? fromRuntime : devTenantProps(c.env, dev);
    if (!props || props.tenant.id !== tenantId) {
      console.error("[hosted] missing props, another contract version, or another tenant's props");
      return c.json({ error: HOSTED_ERRORS.unavailable }, 503);
    }
    c.set("hosted", props);
    // Email goes out through the platform (notifications/mail.ts), on this call's env only.
    c.env = { ...c.env, MAIL_TRANSPORT: platformTransport(props.platform) };
    return next();
  };
}

/** How long a visitor is asked to wait while the database is older than the bundle. */
export const UPDATING_RETRY_AFTER_SECONDS = 10;

const UPDATING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${UPDATING_RETRY_AFTER_SECONDS}">
<title>Updating | OpenPing</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f8fb; --ink: #121826; --muted: #5b6475; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1020; --ink: #e8ebf3; --muted: #9aa3b5; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 22rem; text-align: center; }
  h1 { font-size: 1.125rem; margin: 0 0 .5rem; }
  p { margin: 0; color: var(--muted); font-size: .875rem; }
</style>
</head>
<body>
<main>
<h1>This OpenPing is updating</h1>
<p>It will be back in a few seconds. This page reloads on its own.</p>
</main>
</body>
</html>
`;

/**
 * A public call in hosted mode, right after the hosted gate: when the database
 * is older than the bundle, answer 503 "updating" with Retry-After and do
 * nothing else (contract, section 6). It never migrates: only platform calls
 * do (routes/platform.ts), so a visitor's request, which the browser may cancel
 * at any moment, can never hold the migration lock. The check is a read at
 * most, and none while this isolate saw the schema current recently. A plain
 * install passes straight through: its migrations run from `npm run deploy`.
 */
export const hostedSchemaGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!hostedProps(c) || isInternalPath(c.req.path)) return next();
  if ((await schemaIsCurrent(c.env.DB)) !== false) return next();
  c.header("Retry-After", String(UPDATING_RETRY_AFTER_SECONDS));
  c.header("Cache-Control", "no-store");
  const page = c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");
  return page ? c.html(UPDATING_PAGE, 503) : c.json({ error: HOSTED_ERRORS.updating }, 503);
};

/** The 404 every platform-managed path answers in hosted mode (contract, section 8). */
export function managedByPlatform(c: Ctx): Response {
  return c.json({ error: HOSTED_ERRORS.managedByPlatform }, 404);
}

/**
 * Refuses a route in hosted mode with 404 `managed_by_platform`: first-run
 * setup, SETUP_TOKEN recovery, GitHub OAuth and the email magic link, which
 * the platform's own sign-in replaces. A plain install passes through.
 */
export const refuseWhenHosted: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (hostedMode(c.env)) return managedByPlatform(c);
  await next();
};

// ---------------------------------------------------------------------------
// Signing out to the platform
// ---------------------------------------------------------------------------

/**
 * Signing out in hosted mode ends the platform's session too, by going to
 * `props.tenant.urls.signOut` (contract, section 7). The browser's own sign-out
 * goes to /login once the API call returns, so the API call leaves this
 * short-lived marker, and GET /login (signOutRedirect) sends a browser that
 * carries it on to the platform instead of showing the sign-in page.
 */
const SIGNED_OUT_COOKIE = "op_signed_out";
const SIGNED_OUT_TTL_SECONDS = 120;

/** After ending a session in hosted mode: mark the browser and return the platform's sign-out URL. */
export function markSignedOut(c: Ctx): string | null {
  const props = hostedProps(c);
  if (!props) return null;
  setCookie(c, SIGNED_OUT_COOKIE, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/login",
    maxAge: SIGNED_OUT_TTL_SECONDS,
  });
  return props.tenant.urls.signOut;
}

/** GET /login: in hosted mode, right after a sign-out, continue to the platform's sign-out. */
export const signOutRedirect: MiddlewareHandler<AppEnv> = async (c, next) => {
  const props = hostedProps(c);
  if (!props || !getCookie(c, SIGNED_OUT_COOKIE)) return next();
  deleteCookie(c, SIGNED_OUT_COOKIE, { path: "/login", secure: true });
  // The Android app stays on its own sign-in screen: the platform's pages
  // open in the phone's browser, not in the app (docs/ANDROID.md).
  if (isAppUserAgent(c.req.header("user-agent"))) return next();
  c.header("Cache-Control", "no-store");
  return c.redirect(props.tenant.urls.signOut, 302);
};

/** What the signed-out sign-in screens need in hosted mode (unauthenticated /api/auth/status). */
export function hostedStatus(props: TenantProps): { signInUrl: string } {
  return { signInUrl: props.tenant.urls.signIn };
}

/** What Settings shows a signed-in customer in hosted mode (/api/auth/me). */
export function hostedAccount(props: TenantProps) {
  const { tenant } = props;
  return {
    slug: tenant.slug,
    plan: tenant.plan,
    status: tenant.status,
    trialEndsAt: tenant.trialEndsAt,
    accountUrl: tenant.urls.account,
    billingUrl: tenant.urls.billing,
    upgradeUrl: tenant.urls.upgrade,
    signOutUrl: tenant.urls.signOut,
    // What the plan includes, so the app can show how much is left (lib/plan-limits.ts enforces it).
    limits: tenant.limits,
  };
}
