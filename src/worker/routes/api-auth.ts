import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { getSession, destroySession, listSessions, revokeAllSessions, revokeSession, SESSION_COOKIE } from "../lib/sessions";
import { getAdminGithubLogin, getAdminEmail } from "../lib/admin";
import { getSetting } from "../db/settings";
import { timingSafeEqual } from "../lib/timing";
import { isValidMasterKey } from "../lib/crypto";
import { homePage, hostedSignupUrl } from "../lib/home-page";
import { waitlistEnabled } from "./waitlist";
import { countPasskeys, getPasskey } from "../db/passkeys";
import { relyingParty } from "../lib/passkey-ceremony";
import { hostedAccount, hostedProps, hostedStatus, markSignedOut } from "../lib/hosted";
import { requireAuth } from "../middleware/auth";
import { SUPPORT_RESTRICTED, auditSupportChange, isSupportSession, listSupportActivity, recordSupportActivity } from "../lib/support";

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
  const hosted = hostedProps(c);
  return c.json({
    authenticated: true,
    identity,
    identityKind: session.identity_kind,
    csrf: session.csrf_secret,
    expiresAt: session.expires_at,
    // Hosted mode only: the plan and the links into the platform for Settings.
    ...(hosted ? { hosted: hostedAccount(hosted) } : {}),
  });
});

/**
 * Unauthenticated bootstrap info for the login/setup screens, and what `/`
 * shows a signed-out visitor (`homePage`), which the app reads before it
 * renders anything at `/`, so no visitor sees the wrong page first.
 */
apiAuth.get("/status", async (c) => {
  const rp = await relyingParty(c);
  const hosted = hostedProps(c);
  if (hosted) {
    // Hosted mode: the platform set this OpenPing up and signs its customer
    // in, so there is no wizard, GitHub app or email link to offer; the
    // customer's own passkeys still work.
    return c.json({
      setupComplete: true,
      encryptionConfigured: isValidMasterKey(c.env.MASTER_KEY),
      githubEnabled: false,
      githubAdminConfigured: false,
      emailAdminConfigured: false,
      passkeyConfigured: (await countPasskeys(c.env)) > 0,
      passkeyRpId: rp.rpId,
      passkeyOrigin: rp.origin,
      homePage: homePage(c.env),
      waitlistEnabled: waitlistEnabled(c.env),
      hosted: hostedStatus(hosted),
      appSignIn: APP_SIGNIN_VERSION,
    });
  }
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
    appSignIn: APP_SIGNIN_VERSION,
    // Only once Hosted opens, so the answer is unchanged until then.
    ...hostedOffer(c.env),
  });
});

/**
 * The version of the Android app's browser sign-in this install speaks
 * (routes/app-signin.ts). The app reads it before it adds an install, and asks
 * an older one to update first.
 */
export const APP_SIGNIN_VERSION = 1;

/** `hostedSignupUrl` for the landing page's trial buttons, present only when the var is set and valid. */
function hostedOffer(env: AppEnv["Bindings"]): { hostedSignupUrl?: string } {
  const url = hostedSignupUrl(env);
  return url ? { hostedSignupUrl: url } : {};
}

/** Explicit logout. Requires a valid session + matching CSRF token. */
apiAuth.post("/logout", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const csrf = c.req.header("x-csrf-token");
  if (!csrf || !(await timingSafeEqual(csrf, session.csrf_secret))) {
    return c.json({ error: "csrf_failed" }, 403);
  }
  await destroySession(c);
  // Hosted mode: the sign-out continues to the platform's (lib/hosted.ts).
  const signOutUrl = markSignedOut(c);
  return c.json(signOutUrl ? { ok: true, signOutUrl } : { ok: true });
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
  // Support can't sign the customer out of everything (lib/support.ts).
  if (isSupportSession(session)) {
    await recordSupportActivity(c.env, { kind: "refused", identity: session.identity, method: "POST", path: c.req.path, status: 403 });
    await auditSupportChange(c, { method: "POST", path: c.req.path, status: 403, refused: "sessions" });
    return c.json(SUPPORT_RESTRICTED, 403);
  }
  await revokeAllSessions(c.env);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  const signOutUrl = markSignedOut(c);
  return c.json(signOutUrl ? { ok: true, signOutUrl } : { ok: true });
});

/**
 * Every signed-in session (Settings > Sign-in & security): which way it signed
 * in, whether it is the Android app's, its browser, and when it was last used.
 */
apiAuth.get("/sessions", requireAuth, async (c) => {
  const current = c.get("session")?.id ?? null;
  return c.json({ sessions: await listSessions(c.env, current) });
});

/** Sign one session out: a phone you lost, the app on a phone you don't recognise. */
apiAuth.delete("/sessions/:id", requireAuth, async (c) => {
  const session = c.get("session");
  // Support can't sign the customer out (lib/support.ts).
  if (session && isSupportSession(session)) {
    await recordSupportActivity(c.env, { kind: "refused", identity: session.identity, method: "DELETE", path: c.req.path, status: 403 });
    await auditSupportChange(c, { method: "DELETE", path: c.req.path, status: 403, refused: "sessions" });
    return c.json(SUPPORT_RESTRICTED, 403);
  }
  const id = c.req.param("id");
  if (!/^[0-9a-f]{64}$/.test(id) || !(await revokeSession(c.env, id))) return c.json({ error: "not_found" }, 404);
  if (session?.id === id) deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/**
 * What OpenPing Hosted support did here (lib/support.ts): its sign-ins, its
 * changes and the changes it was refused, newest first. Empty on a plain
 * install, where support never signs in.
 */
apiAuth.get("/support-activity", requireAuth, async (c) => {
  return c.json({ entries: await listSupportActivity(c.env) });
});
