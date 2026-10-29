/**
 * The platform Worker's request handling: route by hostname, serve the
 * platform's own pages on app.<domain>, and dispatch <slug>.<domain> to that
 * customer's OpenPing.
 *
 * Built from injected dependencies, so tests run the real routing against
 * the in-memory dispatcher (test/fake-dispatcher.ts) and production runs it
 * against the dispatch namespace (src/index.ts).
 */

import { Hono } from "hono";

import { accountRoutes, type AccountDeps } from "./account-routes";
import { billingSetup } from "./billing/config";
import { handleStripeWebhook } from "./billing/webhook";
import { adminRoutes } from "./admin/routes";
import { HOSTED_ERRORS, isInternalPath, type PlatformCapability } from "../../src/shared/hosted-contract";
import { DISPATCH_LIMITS, buildTenantProps, newCallId, publicRequest, type TenantDispatcher } from "./dispatch";
import type { PlatformEnv } from "./env";
import { appOrigin, classifyHost } from "./hosts";
import { mailerFromEnv } from "./mail";
import {
  appNotFoundPage,
  tenantNotFoundPage,
  tenantProvisioningPage,
  tenantSuspendedPage,
  tenantUnavailablePage,
  unknownHostPage,
} from "./pages";
import { slugProblem } from "./slugs";
import { cachedTenantBySlug, hostedUrls, type TenantRecord } from "./tenants";

export interface AppDeps {
  /** The dispatcher for this request's env. */
  dispatcher(env: PlatformEnv): TenantDispatcher;
  /** The capability stub a call to `tenant` gets as `props.platform`. */
  capability(env: PlatformEnv, ctx: ExecutionContext, tenant: TenantRecord): PlatformCapability;
  /** Sign-in and the account pages; by default mail from the env and provisioning off. */
  accounts?: AccountDeps;
  /** Tests only: a fixed call id. */
  newCallId?: () => string;
}

const DEFAULT_ACCOUNT_DEPS: AccountDeps = {
  mailer: (env) => mailerFromEnv(env),
  provisioning: () => ({ ok: false, missing: ["provisioning is not wired in this app"] }),
};

type Platform = { Bindings: PlatformEnv };

const NO_STORE = { "cache-control": "no-store" };

/** The platform's own pages on app.<domain>: sign-up, sign-in, the account, billing and the owner's console. */
function appHost(deps: AppDeps): Hono<Platform> {
  const app = new Hono<Platform>();

  // For uptime monitors of the platform itself (C4): the Worker runs and its database answers.
  app.get("/healthz", async (c) => {
    try {
      await c.env.PLATFORM_DB.prepare("SELECT 1").first();
      return c.json({ ok: true, service: "openping-platform", db: "ok" }, 200, NO_STORE);
    } catch (error) {
      console.error("[healthz] platform database check failed", error);
      return c.json({ ok: false, service: "openping-platform", db: "error" }, 503, NO_STORE);
    }
  });

  const accounts = deps.accounts ?? DEFAULT_ACCOUNT_DEPS;

  // Stripe's signed events (B5). Before the account routes: it is called by
  // Stripe, not a browser, so it has no session and no Origin, and its
  // signature is the check (src/billing/webhook.ts).
  app.post("/stripe/webhook", (c) =>
    handleStripeWebhook(c.req.raw, {
      db: c.env.PLATFORM_DB,
      setup: (accounts.billing ?? ((env: PlatformEnv) => billingSetup(env)))(c.env),
      mailer: accounts.mailer(c.env),
      appOrigin: appOrigin(c.env.HOSTED_DOMAIN),
      now: (accounts.now ?? Date.now)(),
    }),
  );
  // Before the account routes: /admin answers its own 404 to everyone but the owner.
  app.route(
    "/admin",
    adminRoutes({ dispatcher: deps.dispatcher, capability: deps.capability, provisioning: accounts.provisioning, now: accounts.now }),
  );
  app.route("/", accountRoutes(accounts));
  app.notFound((c) => appNotFoundPage(appOrigin(c.env.HOSTED_DOMAIN)));
  return app;
}

async function tenantHost(
  request: Request,
  env: PlatformEnv,
  ctx: ExecutionContext,
  slug: string,
  deps: AppDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const home = appOrigin(env.HOSTED_DOMAIN);

  // Internal paths are for the platform's own calls (callTenant) only. A
  // visitor's request for one never reaches the tenant, whatever it carries.
  if (isInternalPath(url.pathname)) {
    return Response.json({ error: HOSTED_ERRORS.notFound }, { status: 404, headers: NO_STORE });
  }

  if (slugProblem(slug)) return tenantNotFoundPage(url.hostname, home);
  const tenant = await cachedTenantBySlug(env.PLATFORM_DB, slug);
  if (!tenant || tenant.provisionState === "deleting") return tenantNotFoundPage(url.hostname, home);
  if (tenant.provisionState !== "ready") return tenantProvisioningPage();
  if (tenant.status === "suspended") return tenantSuspendedPage(hostedUrls(tenant.slug, env.HOSTED_DOMAIN).account);

  const props = buildTenantProps({
    tenant,
    hostedDomain: env.HOSTED_DOMAIN,
    invocation: "public",
    callId: (deps.newCallId ?? newCallId)(),
    platform: deps.capability(env, ctx, tenant),
  });

  try {
    const result = await deps.dispatcher(env).dispatch(tenant.scriptName, publicRequest(request), props, DISPATCH_LIMITS.public);
    if (result.kind === "missing") {
      // A ready tenant always has a script; this is a provisioning bug, not the visitor's.
      console.error("[dispatch] ready tenant has no user Worker", { tenant: tenant.id, script: tenant.scriptName });
      return tenantUnavailablePage();
    }
    return result.response;
  } catch (error) {
    console.error("[dispatch] user Worker failed", { tenant: tenant.id }, error);
    return tenantUnavailablePage();
  }
}

export function createApp(deps: AppDeps): Hono<Platform> {
  const app = new Hono<Platform>();
  const platformPages = appHost(deps);

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const route = classifyHost(url.hostname, c.env.HOSTED_DOMAIN);
    const ctx = c.executionCtx as ExecutionContext;
    switch (route.kind) {
      case "app":
        return platformPages.fetch(c.req.raw, c.env, ctx);
      case "apex":
        return c.redirect(`${appOrigin(c.env.HOSTED_DOMAIN)}${url.pathname}${url.search}`, 301);
      case "tenant":
        return tenantHost(c.req.raw, c.env, ctx, route.slug, deps);
      default:
        return unknownHostPage();
    }
  });

  app.onError((error) => {
    console.error("[platform] unhandled error", error);
    return tenantUnavailablePage();
  });

  return app;
}
