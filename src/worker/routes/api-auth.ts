import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getSession, destroySession } from "../lib/sessions";
import { getAdminGithubLogin, getAdminEmail } from "../lib/admin";
import { getSetting } from "../db/settings";

/** Session/identity endpoints mounted at /api/auth. */
export const apiAuth = new Hono<AppEnv>();

/** Current session + the CSRF token the client must echo on mutations. */
apiAuth.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ authenticated: false });
  return c.json({
    authenticated: true,
    identity: session.identity,
    identityKind: session.identity_kind,
    csrf: session.csrf_secret,
    expiresAt: session.expires_at,
  });
});

/** Unauthenticated bootstrap info for the login/setup screens. */
apiAuth.get("/status", async (c) => {
  return c.json({
    setupComplete: (await getSetting(c.env, "setup_complete")) === "true",
    githubEnabled: !!c.env.GITHUB_CLIENT_ID,
    githubAdminConfigured: !!(await getAdminGithubLogin(c.env)),
    emailAdminConfigured: !!(await getAdminEmail(c.env)),
  });
});

/** Explicit logout. Requires a valid session + matching CSRF token. */
apiAuth.post("/logout", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const csrf = c.req.header("x-csrf-token");
  if (!csrf || csrf !== session.csrf_secret) {
    return c.json({ error: "csrf_failed" }, 403);
  }
  await destroySession(c);
  return c.json({ ok: true });
});
