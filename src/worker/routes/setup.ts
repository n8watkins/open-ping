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
import { getSession } from "../lib/sessions";

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

/** Block writes after setup completes unless authenticated. */
async function guardWrite(c: Context<AppEnv>): Promise<Response | null> {
  if ((await isSetupComplete(c.env)) && !(await getSession(c))) {
    return c.json({ error: "setup_locked" }, 403);
  }
  return null;
}

setup.get("/state", async (c) => {
  return c.json({ state: await getSetupState(c.env), status: await setupStatus(c.env) });
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
