import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { isAllowedGithubLogin } from "../lib/admin";
import { createSession } from "../lib/sessions";

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
const UA = "OpenPing";

// NOTE: only honors the APP_URL env override, not the `app_url` setting the
// setup wizard writes; when APP_URL is unset this falls back to the spoofable
// request Host header. GitHub validates redirect_uri against the registered
// callback so the blast radius is limited, but set APP_URL in production for a
// stable OAuth base. (magic.ts baseUrl additionally reads the app_url setting.)
function baseUrl(c: { env: Env; req: { url: string } }): string {
  return c.env.APP_URL?.replace(/\/$/, "") ?? new URL(c.req.url).origin;
}

function loginRedirect(base: string, error?: string): Response {
  const url = error ? `${base}/login?error=${encodeURIComponent(error)}` : `${base}/login`;
  return Response.redirect(url, 302);
}

// --- Begin GitHub OAuth ---
auth.get("/github/start", async (c) => {
  const base = baseUrl(c);
  if (!c.env.GITHUB_CLIENT_ID) return loginRedirect(base, "github_not_configured");

  // NOTE (deferred): this `state` is single-use and server-validated on
  // callback, but it is NOT bound to the initiating browser (no paired nonce in
  // an HttpOnly cookie / double-submit), so it only weakly defends against login
  // CSRF / session fixation. Left as-is for now because the single-admin
  // allowlist means a forced login can still only ever resolve to the one admin
  // identity. Revisit by storing a random nonce in a cookie at /start and
  // checking it against this row in /github/callback.
  const state = randomToken(24);
  await c.env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, 'oauth_state', ?, ?, ?)`,
  )
    .bind(await sha256hex(state), JSON.stringify({}), Date.now(), Date.now() + STATE_TTL_MS)
    .run();

  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${base}/auth/github/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return Response.redirect(authorize.toString(), 302);
});

// --- GitHub OAuth callback ---
auth.get("/github/callback", async (c) => {
  const base = baseUrl(c);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return loginRedirect(base, "invalid_callback");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return loginRedirect(base, "github_not_configured");
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
    return loginRedirect(base, "state_invalid");
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
    if (!tokenJson.access_token) return loginRedirect(base, "token_exchange_failed");
    accessToken = tokenJson.access_token;
  } catch {
    return loginRedirect(base, "token_exchange_failed");
  }

  // Fetch the GitHub identity.
  let login: string;
  try {
    const userRes = await fetch(GITHUB_USER, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": UA },
    });
    const user = (await userRes.json()) as { login?: string };
    if (!user.login) return loginRedirect(base, "identity_failed");
    login = user.login;
  } catch {
    return loginRedirect(base, "identity_failed");
  }

  if (!(await isAllowedGithubLogin(c.env, login))) {
    return loginRedirect(base, "not_authorized");
  }

  // Rotate: a fresh session is issued on every login.
  await createSession(c, login, "github");
  return Response.redirect(`${base}/`, 302);
});
