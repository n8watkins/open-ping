import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Env } from "../types";
import {
  getSetupState,
  saveSetupStep,
  isSetupComplete,
  markSetupComplete,
} from "../db/setup";
import { getAdminGithubLogin, getAdminEmail, hasAdminConfigured } from "../lib/admin";
import { getSetting } from "../db/settings";
import { CSRF_HEADER, getSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * First-run setup API mounted at /api/setup. Writable while setup is incomplete
 * (bootstrap is unauthenticated by necessity); once complete, mutations require
 * an authenticated session so later edits go through the same guard as settings.
 */
export const setup = new Hono<AppEnv>();

async function setupStatus(env: Env) {
  return {
    setupComplete: await isSetupComplete(env),
    githubEnabled: !!env.GITHUB_CLIENT_ID,
    githubAdminConfigured: !!(await getAdminGithubLogin(env)),
    emailAdminConfigured: !!(await getAdminEmail(env)),
    resendConfigured: !!env.RESEND_API_KEY,
    appUrl: await getSetting(env, "app_url"),
    timezone: await getSetting(env, "timezone"),
  };
}

/**
 * Block anonymous writes once setup is complete OR an administrator identity
 * already exists (env or settings). Without the latter check, during the
 * pre-completion bootstrap window any anonymous caller could POST /save an
 * adminEmail, /complete, then log in — admin injection. The request that first
 * writes the admin still succeeds because guardWrite runs at request-start,
 * before saveSetupStep persists the identity; every subsequent mutation then
 * requires a session. Whenever a session is present, also enforce CSRF on
 * state-changing methods exactly like middleware/auth.ts, so a completed-setup
 * deployment can't have its admin identity rewritten by a forged cross-site
 * request.
 */
async function guardWrite(c: Context<AppEnv>): Promise<Response | null> {
  const session = await getSession(c);
  if (((await isSetupComplete(c.env)) || (await hasAdminConfigured(c.env))) && !session) {
    return c.json({ error: "setup_locked" }, 403);
  }
  if (session && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
    const provided = c.req.header(CSRF_HEADER);
    if (!provided || !timingSafeEqual(provided, session.csrf_secret)) {
      return c.json({ error: "csrf_failed" }, 403);
    }
  }
  return null;
}

setup.get("/state", async (c) => {
  const status = await setupStatus(c.env);
  const state = await getSetupState(c.env);
  // The wizard's collected `data` mirrors the administrator's GitHub login /
  // email. During first-run setup the endpoint is unauthenticated by necessity
  // (bootstrap), but once setup is complete an anonymous caller must NOT be able
  // to read that identity back — the sibling /api/auth/status deliberately
  // exposes only booleans. After completion, redact `data` unless authenticated.
  if (status.setupComplete && !(await getSession(c))) {
    return c.json({ state: { ...state, data: {} }, status });
  }
  return c.json({ state, status });
});

setup.post("/save", async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) return blocked;

  const body = await c.req.json<{
    step?: number;
    stepId?: string;
    data?: Record<string, unknown>;
  }>().catch(() => ({}));

  const state = await saveSetupStep(c.env, body);
  return c.json({ state, status: await setupStatus(c.env) });
});

setup.post("/complete", async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) return blocked;

  const status = await setupStatus(c.env);
  if (!status.githubAdminConfigured && !status.emailAdminConfigured) {
    return c.json({ error: "no_admin_configured" }, 400);
  }
  if (!status.timezone) {
    return c.json({ error: "timezone_required" }, 400);
  }
  // app_url is embedded into single-use magic-link and OAuth redirect URLs;
  // without it routes/magic.ts and routes/auth.ts fall back to the request Host
  // header, which an attacker can spoof to capture an emailed sign-in token.
  // Require a real app_url (env override or the wizard-written setting) before
  // completion so a finished deployment never depends on that Host fallback.
  if (!c.env.APP_URL && !status.appUrl) {
    return c.json({ error: "app_url_required" }, 400);
  }
  await markSetupComplete(c.env);
  return c.json({ ok: true, status: await setupStatus(c.env) });
});
