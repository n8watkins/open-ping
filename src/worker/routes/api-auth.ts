import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { getSession, destroySession, revokeAllSessions, SESSION_COOKIE } from "../lib/sessions";
import { getAdminGithubLogin, getAdminEmail } from "../lib/admin";
import { getSetting } from "../db/settings";
import { timingSafeEqual } from "../lib/timing";
import { isValidMasterKey } from "../lib/crypto";
import { homePage } from "../lib/home-page";
import { waitlistEnabled } from "./waitlist";
import { countPasskeys, getPasskey } from "../db/passkeys";
import { relyingParty } from "../lib/passkey-ceremony";

/** Session/identity endpoints mounted at /api/auth. */
export const apiAuth = new Hono<AppEnv>();

/** Current session + the CSRF token the client must echo on mutations. */
apiAuth.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ authenticated: false });
  // A passkey session's identity is the passkey's row id; show its name.
  const identity =
    session.identity_kind === "passkey"
      ? ((await getPasskey(c.env, session.identity))?.name ?? "Passkey")
      : session.identity;
  return c.json({
    authenticated: true,
    identity,
    identityKind: session.identity_kind,
    csrf: session.csrf_secret,
    expiresAt: session.expires_at,
  });
});

/**
 * Unauthenticated bootstrap info for the login/setup screens, and what `/`
 * shows a signed-out visitor (`homePage`), which the app reads before it
 * renders anything at `/`, so no visitor sees the wrong page first.
 */
apiAuth.get("/status", async (c) => {
  const rp = await relyingParty(c);
  return c.json({
    setupComplete: (await getSetting(c.env, "setup_complete")) === "true",
    encryptionConfigured: isValidMasterKey(c.env.MASTER_KEY),
    githubEnabled: !!c.env.GITHUB_CLIENT_ID,
    githubAdminConfigured: !!(await getAdminGithubLogin(c.env)),
    emailAdminConfigured: !!(await getAdminEmail(c.env)),
    // Passkey sign-in is offered only on installs that have one, and only on
    // the hostname passkeys are bound to (lib/passkey-ceremony.ts).
    passkeyConfigured: (await countPasskeys(c.env)) > 0,
    passkeyRpId: rp.rpId,
    passkeyOrigin: rp.origin,
    homePage: homePage(c.env),
    waitlistEnabled: waitlistEnabled(c.env),
  });
});

/** Explicit logout. Requires a valid session + matching CSRF token. */
apiAuth.post("/logout", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const csrf = c.req.header("x-csrf-token");
  if (!csrf || !(await timingSafeEqual(csrf, session.csrf_secret))) {
    return c.json({ error: "csrf_failed" }, 403);
  }
  await destroySession(c);
  return c.json({ ok: true });
});

/**
 * Sign out everywhere: revoke ALL sessions, whichever way (GitHub, email or a
 * passkey) they signed in, not just the current cookie. Lets the admin forcibly kill a leaked/stolen session token
 * (which is otherwise valid for up to 30 days) without waiting for expiry.
 */
apiAuth.post("/logout-all", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const csrf = c.req.header("x-csrf-token");
  if (!csrf || !(await timingSafeEqual(csrf, session.csrf_secret))) {
    return c.json({ error: "csrf_failed" }, 403);
  }
  await revokeAllSessions(c.env);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
