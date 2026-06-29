import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Env } from "../types";
import {
  getSetupState,
  saveSetupStep,
  isSetupComplete,
  markSetupComplete,
} from "../db/setup";
import { getAdminGithubLogin, getAdminEmail } from "../lib/admin";
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
 * Block writes after setup completes unless authenticated, and — whenever a
 * session is present — enforce CSRF on state-changing methods exactly like
 * middleware/auth.ts, so a completed-setup deployment can't have its admin
 * identity rewritten by a forged cross-site request.
 */
async function guardWrite(c: Context<AppEnv>): Promise<Response | null> {
  const session = await getSession(c);
  if ((await isSetupComplete(c.env)) && !session) {
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
  await markSetupComplete(c.env);
  return c.json({ ok: true, status: await setupStatus(c.env) });
});
