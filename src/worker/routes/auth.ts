import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { isAllowedGithubLogin } from "../lib/admin";
import { createSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";

/**
 * Browser-facing auth flows mounted at /auth. GitHub OAuth (PRD §13):
 * minimal identity scope, server-side state validation, allowlisted login,
 * client secret only ever read from a Worker secret.
 */
export const auth = new Hono<AppEnv>();

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";
const STATE_TTL_MS = 1000 * 60 * 10; // 10 minutes
const STATE_COOKIE = "op_oauth_state";
const UA = "OpenPing";

// NOTE: only honors the APP_URL env override, not the `app_url` setting the
// setup wizard writes; when APP_URL is unset this falls back to the spoofable
// request Host header. GitHub validates redirect_uri against the registered
// callback so the blast radius is limited, but set APP_URL in production for a
// stable OAuth base. (magic.ts baseUrl additionally reads the app_url setting.)
function baseUrl(c: { env: Env; req: { url: string } }): string {
  return c.env.APP_URL?.replace(/\/$/, "") ?? new URL(c.req.url).origin;
}

// Use c.redirect (NOT Response.redirect): Response.redirect returns a brand-new
// Response that discards anything set on c.res — including Set-Cookie headers from
// setCookie()/createSession(). c.redirect preserves them, so the OAuth state and
// session cookies actually reach the browser.
function loginRedirect(c: Context<AppEnv>, error?: string): Response {
  const base = baseUrl(c);
  const url = error ? `${base}/login?error=${encodeURIComponent(error)}` : `${base}/login`;
  return c.redirect(url, 302);
}

// --- Begin GitHub OAuth ---
auth.get("/github/start", async (c) => {
  const base = baseUrl(c);
  if (!c.env.GITHUB_CLIENT_ID) return loginRedirect(c,"github_not_configured");

  // The `state` is single-use and server-validated on callback, AND bound to the
  // initiating browser via a matching HttpOnly cookie (double-submit). The
  // callback requires both the server row and the cookie to match the returned
  // `state`, so an attacker who can't read the victim's cookie can't forge a
  // login-CSRF / fixation flow. (The single-admin allowlist already bounds the
  // blast radius, but this closes the gap properly.)
  const state = randomToken(24);
  await c.env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, 'oauth_state', ?, ?, ?)`,
  )
    .bind(await sha256hex(state), JSON.stringify({}), Date.now(), Date.now() + STATE_TTL_MS)
    .run();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax", // sent on the top-level GET navigation back from GitHub
    path: "/auth/github",
    maxAge: STATE_TTL_MS / 1000,
  });

  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${base}/auth/github/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return c.redirect(authorize.toString(), 302);
});

// --- GitHub OAuth callback ---
auth.get("/github/callback", async (c) => {
  const base = baseUrl(c);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return loginRedirect(c,"invalid_callback");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return loginRedirect(c,"github_not_configured");
  }

  // Bind to the initiating browser: the state cookie set at /start must match
  // the returned `state` (constant-time). Clear it regardless of outcome.
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth/github" });
  if (!cookieState || !(await timingSafeEqual(cookieState, state))) {
    return loginRedirect(c,"state_invalid");
  }

  // Validate + consume single-use state.
  const stateId = await sha256hex(state);
  const stateRow = await c.env.DB.prepare(
    `SELECT id, expires_at, used_at FROM auth_tokens WHERE id = ? AND kind = 'oauth_state'`,
  )
    .bind(stateId)
    .first<{ id: string; expires_at: number; used_at: number | null }>();
  await c.env.DB.prepare(`DELETE FROM auth_tokens WHERE id = ?`).bind(stateId).run();
  if (!stateRow || stateRow.used_at || stateRow.expires_at <= Date.now()) {
    return loginRedirect(c,"state_invalid");
  }

  // Exchange code for an access token.
  let accessToken: string;
  try {
    const tokenRes = await fetch(GITHUB_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${base}/auth/github/callback`,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token) return loginRedirect(c,"token_exchange_failed");
    accessToken = tokenJson.access_token;
  } catch {
    return loginRedirect(c,"token_exchange_failed");
  }

  // Fetch the GitHub identity.
  let login: string;
  try {
    const userRes = await fetch(GITHUB_USER, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": UA },
    });
    const user = (await userRes.json()) as { login?: string };
    if (!user.login) return loginRedirect(c,"identity_failed");
    login = user.login;
  } catch {
    return loginRedirect(c,"identity_failed");
  }

  if (!(await isAllowedGithubLogin(c.env, login))) {
    return loginRedirect(c,"not_authorized");
  }

  // Rotate: a fresh session is issued on every login.
  await createSession(c, login, "github");
  return c.redirect(`${base}/`, 302);
});
