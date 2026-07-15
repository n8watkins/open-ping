import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Env } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { isAllowedGithubLogin } from "../lib/admin";
import { createSession } from "../lib/sessions";
import { timingSafeEqual } from "../lib/timing";
import { getSetting } from "../db/settings";
import { hitRateLimit } from "../db/rate-limit";

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
const OAUTH_PER_IP_LIMIT = 20;
const OAUTH_GLOBAL_LIMIT = 500;
const UNKNOWN_IP = "unknown";

/** Resolve the configured OAuth origin before falling back to the request URL. */
async function baseUrl(c: { env: Env; req: { url: string } }): Promise<string> {
  const configured = c.env.APP_URL ?? (await getSetting(c.env, "app_url"));
  if (configured) {
    try {
      const url = new URL(configured);
      if (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) &&
        !url.username &&
        !url.password
      ) {
        return url.origin;
      }
    } catch {
      // Invalid legacy setting: use the request origin rather than emitting it.
    }
  }
  return new URL(c.req.url).origin;
}

// Use c.redirect (NOT Response.redirect): Response.redirect returns a brand-new
// Response that discards anything set on c.res — including Set-Cookie headers from
// setCookie()/createSession(). c.redirect preserves them, so the OAuth state and
// session cookies actually reach the browser.
function loginRedirect(c: Context<AppEnv>, base: string, error?: string): Response {
  const url = error ? `${base}/login?error=${encodeURIComponent(error)}` : `${base}/login`;
  return c.redirect(url, 302);
}

// --- Begin GitHub OAuth ---
auth.get("/github/start", async (c) => {
  const base = await baseUrl(c);
  if (!c.env.GITHUB_CLIENT_ID) return loginRedirect(c, base, "github_not_configured");

  const ip = c.req.header("cf-connecting-ip") ?? UNKNOWN_IP;
  const ipHit = await hitRateLimit(c.env, `oauth:ip:${ip}`, OAUTH_PER_IP_LIMIT);
  if (!ipHit.allowed) {
    c.header("Retry-After", String(ipHit.retryAfterSeconds));
    return loginRedirect(c, base, "rate_limited");
  }
  const globalHit = await hitRateLimit(c.env, "oauth:global", OAUTH_GLOBAL_LIMIT);
  if (!globalHit.allowed) {
    c.header("Retry-After", String(globalHit.retryAfterSeconds));
    return loginRedirect(c, base, "rate_limited");
  }

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
  const base = await baseUrl(c);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return loginRedirect(c, base, "invalid_callback");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return loginRedirect(c, base, "github_not_configured");
  }

  // Bind to the initiating browser: the state cookie set at /start must match
  // the returned `state` (constant-time). Clear it regardless of outcome.
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth/github" });
  if (!cookieState || !(await timingSafeEqual(cookieState, state))) {
    // Cookie absent or ≠ the returned state: stale/replayed callback link, a
    // second tab clobbering the singleton cookie, or a direct callback hit.
    return loginRedirect(c, base, "state_missing");
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
    // Server-side state row gone/used/expired: usually the 10-min TTL lapsed
    // while the user sat on GitHub's authorize/2FA screen.
    return loginRedirect(c, base, "state_expired");
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
    if (!tokenJson.access_token) return loginRedirect(c, base, "token_exchange_failed");
    accessToken = tokenJson.access_token;
  } catch {
    return loginRedirect(c, base, "token_exchange_failed");
  }

  // Fetch the GitHub identity.
  let login: string;
  try {
    const userRes = await fetch(GITHUB_USER, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": UA },
    });
    const user = (await userRes.json()) as { login?: string };
    if (!user.login) return loginRedirect(c, base, "identity_failed");
    login = user.login;
  } catch {
    return loginRedirect(c, base, "identity_failed");
  }

  if (!(await isAllowedGithubLogin(c.env, login))) {
    return loginRedirect(c, base, "not_authorized");
  }

  // Rotate: a fresh session is issued on every login.
  await createSession(c, login, "github");
  return c.redirect(`${base}/`, 302);
});
