import { Hono } from "hono";
import type { Context } from "hono";
import { DateTime } from "luxon";
import { z } from "zod";
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
import { isValidMasterKey } from "../lib/crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SETUP_TOKEN_HEADER = "x-setup-token";

const setupStepSchema = z.enum([
  "welcome",
  "url",
  "timezone",
  "admin",
  "notifications",
  "monitor",
  "finish",
]);

const appUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "must be an https origin (http is allowed only for local development)");

const githubLoginSchema = z
  .string()
  .max(39)
  .refine(
    (value) =>
      value === "" ||
      (/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) &&
        !value.includes("--")),
    "must be a valid GitHub username",
  );

export const setupSaveSchema = z.object({
  step: z.number().int().min(0).max(6).optional(),
  stepId: setupStepSchema.optional(),
  data: z
    .object({
      appUrl: appUrlSchema.optional(),
      timezone: z
        .string()
        .max(100)
        .refine((value) => DateTime.local().setZone(value).isValid, "invalid timezone")
        .optional(),
      adminGithubLogin: githubLoginSchema.optional(),
      adminEmail: z.string().max(320).email().or(z.literal("")).optional(),
    })
    .strict()
    .optional(),
});

/** Constant-time setup-token check kept separate for focused security tests. */
export async function checkSetupToken(
  configured: string | undefined,
  provided: string | undefined,
): Promise<boolean> {
  return !!configured && !!provided && (await timingSafeEqual(provided, configured));
}

/**
 * First-run setup API mounted at /api/setup. Before an administrator can sign
 * in, every request requires the deployment's SETUP_TOKEN. Once authenticated,
 * the admin may finish setup with the normal session + CSRF controls. After
 * completion, the setup token is no longer accepted.
 */
export const setup = new Hono<AppEnv>();

async function setupStatus(env: Env) {
  return {
    setupComplete: await isSetupComplete(env),
    encryptionConfigured: isValidMasterKey(env.MASTER_KEY),
    githubEnabled: !!env.GITHUB_CLIENT_ID,
    githubAdminConfigured: !!(await getAdminGithubLogin(env)),
    emailAdminConfigured: !!(await getAdminEmail(env)),
    resendConfigured: !!env.RESEND_API_KEY,
    appUrl: await getSetting(env, "app_url"),
    timezone: await getSetting(env, "timezone"),
  };
}

/**
 * Authorize setup access. A session is sufficient for reads and requires CSRF
 * for writes. Without a session, setup must still be incomplete and a configured
 * SETUP_TOKEN must match the dedicated request header. This prevents a newly
 * deployed public instance from being claimed by whichever anonymous visitor
 * reaches the wizard first.
 */
async function guardSetup(c: Context<AppEnv>): Promise<Response | null> {
  const session = await getSession(c);
  if (session) {
    if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
      const provided = c.req.header(CSRF_HEADER);
      if (!provided || !(await timingSafeEqual(provided, session.csrf_secret))) {
        return c.json({ error: "csrf_failed" }, 403);
      }
    }
    return null;
  }

  if (await isSetupComplete(c.env)) return c.json({ error: "setup_locked" }, 403);
  if (!c.env.SETUP_TOKEN) {
    return c.json({ error: "setup_token_not_configured" }, 503);
  }
  const provided = c.req.header(SETUP_TOKEN_HEADER);
  if (!(await checkSetupToken(c.env.SETUP_TOKEN, provided))) {
    return c.json({ error: "setup_token_invalid" }, 403);
  }

  return null;
}

setup.get("/state", async (c) => {
  const blocked = await guardSetup(c);
  if (blocked) return blocked;

  const status = await setupStatus(c.env);
  const state = await getSetupState(c.env);
  return c.json({ state, status });
});

setup.post("/save", async (c) => {
  const blocked = await guardSetup(c);
  if (blocked) return blocked;

  const body = await c.req.json().catch(() => undefined);
  const parsed = setupSaveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }

  const state = await saveSetupStep(c.env, parsed.data);
  return c.json({ state, status: await setupStatus(c.env) });
});

setup.post("/complete", async (c) => {
  const blocked = await guardSetup(c);
  if (blocked) return blocked;

  const status = await setupStatus(c.env);
  if (!status.encryptionConfigured) {
    return c.json({ error: "master_key_required" }, 400);
  }
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
  if (!appUrlSchema.safeParse(c.env.APP_URL ?? status.appUrl).success) {
    return c.json({ error: "app_url_required" }, 400);
  }
  await markSetupComplete(c.env);
  return c.json({ ok: true, status: await setupStatus(c.env) });
});
