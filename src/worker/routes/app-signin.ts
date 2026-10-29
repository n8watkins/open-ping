import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, IdentityKind } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { createSession, destroySession, endCurrentSession, getSession } from "../lib/sessions";
import { hitRateLimit } from "../db/rate-limit";
import { timingSafeEqual } from "../lib/timing";
import { hostedProps } from "../lib/hosted";
import { renderPlainPage } from "../lib/plain-page";
import {
  APP_REDIRECT_URI,
  APP_SIGNIN_PATHS,
  APP_STATE_PATTERN,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
} from "../../shared/native-app";

/**
 * Signing in to the OpenPing Android app (docs/ANDROID.md, "Signing in").
 *
 * The app's web view can't do every sign-in itself: an email link opens in the
 * phone's browser, GitHub wants a real browser, and passkeys in a web view need
 * a Digital Asset Links file on every install. So the app signs in the way
 * RFC 8252 asks native apps to, in the browser, and the session comes back to
 * the app with a one-time code that only the app can redeem:
 *
 * 1. The app makes a random verifier and opens, in a Custom Tab,
 *    `GET /auth/app/start?challenge=<base64url SHA-256 of it>&state=<random>`.
 *    That remembers the pair in this browser (a cookie naming a row) and goes
 *    on to the normal sign-in, or straight on when the browser is signed in.
 * 2. Every sign-in (GitHub, the email link, a passkey, the Hosted hand-off)
 *    ends at `afterSignInPath`, which sends a browser with that cookie to
 *    `GET /auth/app/finish` instead of the dashboard.
 * 3. finish shows "Open the OpenPing app": its link carries a one-time code
 *    (2 minutes) to the app's own scheme. A tap is needed, so a page someone
 *    else opened can't sign a phone in unseen, and Chrome only hands a
 *    redirect to an app after one.
 * 4. The app posts the code and its verifier from the web view to
 *    `POST /auth/app/exchange`, which checks the verifier against the
 *    challenge and starts the web view's own session.
 *
 * A code that some other app catches is useless without the verifier, which
 * never leaves the OpenPing app. The browser's own session, when the sign-in
 * made one, ends at step 3: the phone ends up signed in only in the app.
 */
export const appSignIn = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const PENDING_COOKIE = "op_app_signin";
/** How long the browser may take to sign in, from the app's tap. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** How long the code on the "Open the app" page lasts. */
const CODE_TTL_MS = 2 * 60 * 1000;
const PER_IP_LIMIT = 20;
const GLOBAL_LIMIT = 500;
const UNKNOWN_IP = "unknown";

interface PendingSignIn {
  challenge: string;
  state: string;
  /** Whether this browser was signed in before the app asked: then it stays signed in. */
  hadSession: boolean;
}

interface AppCode {
  challenge: string;
  identity: string;
  identityKind: IdentityKind;
}

/**
 * Where a browser goes once a sign-in has made its session: the dashboard, or
 * on to the app when the sign-in started there. Only a cookie read, so every
 * sign-in can call it; finish checks the cookie properly.
 */
export function afterSignInPath(c: Ctx): string {
  return getCookie(c, PENDING_COOKIE) ? APP_SIGNIN_PATHS.finish : "/";
}

async function limited(c: Ctx): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? UNKNOWN_IP;
  for (const [key, limit] of [
    [`app-signin:ip:${ip}`, PER_IP_LIMIT],
    ["app-signin:global", GLOBAL_LIMIT],
  ] as const) {
    const hit = await hitRateLimit(c.env, key, limit);
    if (!hit.allowed) {
      c.header("Retry-After", String(hit.retryAfterSeconds));
      return true;
    }
  }
  return false;
}

function noStore(c: Ctx) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

/** The page for a sign-in that can't go on, with the way back. */
function startAgainPage(c: Ctx, heading: string, text: string, status: 400 | 403 | 429 = 400): Response {
  return c.html(
    renderPlainPage({
      title: "Sign in to the app",
      heading,
      body: [text],
      fine: "Go back to the OpenPing app and tap Sign in again.",
    }),
    status,
  );
}

/** base64url (no padding) of SHA-256(input): a PKCE S256 challenge (RFC 7636 section 4.2). */
export async function s256(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- 1. Start, in the browser ------------------------------------------------
appSignIn.get("/start", async (c) => {
  noStore(c);
  if (await limited(c)) return startAgainPage(c, "Too many sign-in attempts", "Give it a minute and try again.", 429);
  const challenge = c.req.query("challenge") ?? "";
  const state = c.req.query("state") ?? "";
  const method = c.req.query("challenge_method") ?? "S256";
  if (!PKCE_CHALLENGE_PATTERN.test(challenge) || !APP_STATE_PATTERN.test(state) || method !== "S256") {
    return startAgainPage(c, "This sign-in link isn't right", "It didn't come from the OpenPing app, or it was cut short.");
  }

  const session = await getSession(c);
  const pending: PendingSignIn = { challenge, state, hadSession: session !== null };
  const nonce = randomToken(24);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, 'app_signin', ?, ?, ?)`,
  )
    .bind(await sha256hex(nonce), JSON.stringify(pending), now, now + PENDING_TTL_MS)
    .run();
  // Read by every sign-in's last redirect (afterSignInPath), so on "/".
  setCookie(c, PENDING_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: PENDING_TTL_MS / 1000,
  });

  if (session) return c.redirect(APP_SIGNIN_PATHS.finish, 302);
  // OpenPing Hosted signs its customers in on the platform, which hands the
  // browser back to /auth/hosted, which ends at afterSignInPath.
  const hosted = hostedProps(c);
  if (hosted) return c.redirect(hosted.tenant.urls.signIn, 302);
  return c.redirect("/login?app=1", 302);
});

// --- 3. Finish, in the browser, once signed in -------------------------------
appSignIn.get("/finish", async (c) => {
  noStore(c);
  const nonce = getCookie(c, PENDING_COOKIE);
  deleteCookie(c, PENDING_COOKIE, { path: "/", secure: true });
  if (!nonce) {
    return startAgainPage(c, "Nothing to open", "This page continues a sign-in that started in the OpenPing app.");
  }
  const row = await c.env.DB.prepare(
    `DELETE FROM auth_tokens WHERE id = ? AND kind = 'app_signin' RETURNING data, expires_at`,
  )
    .bind(await sha256hex(nonce))
    .first<{ data: string | null; expires_at: number }>();
  const pending = row && row.expires_at > Date.now() ? parsePending(row.data) : null;
  if (!pending) {
    return startAgainPage(c, "This sign-in took too long", "Signing in to the app has to finish within 15 minutes.");
  }

  const session = await getSession(c);
  if (!session) {
    return startAgainPage(c, "You're not signed in", "Sign in first, then the app can open.", 403);
  }
  // A support session (the owner helping a Hosted customer) is short and
  // audited, and stays in the browser it was given to.
  if (session.identity_kind === "hosted_support") {
    return startAgainPage(c, "Support sessions stay in the browser", "A support sign-in can't be moved to the app.", 403);
  }

  const code = randomToken(32);
  const now = Date.now();
  const data: AppCode = { challenge: pending.challenge, identity: session.identity, identityKind: session.identity_kind };
  await c.env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, 'app_code', ?, ?, ?)`,
  )
    .bind(await sha256hex(code), JSON.stringify(data), now, now + CODE_TTL_MS)
    .run();
  // The browser was signed in only for the app: end that session, so the
  // phone is signed in only where the person asked to be.
  if (!pending.hadSession) await destroySession(c);

  const origin = new URL(c.req.url).origin;
  const target = new URL(APP_REDIRECT_URI);
  target.searchParams.set("code", code);
  target.searchParams.set("state", pending.state);
  target.searchParams.set("origin", origin);
  const host = new URL(origin).host;
  return c.html(
    renderPlainPage({
      title: "Open the app",
      heading: "Open the OpenPing app",
      body: [
        `You're signed in to ${host}. Open the OpenPing app on this phone to finish signing in there.`,
        "Only continue if you just tapped Sign in in the OpenPing app.",
      ],
      action: { href: target.toString(), label: "Open the OpenPing app" },
      secondary: { href: "/", label: "Not now" },
      fine: "This button works once, for 2 minutes.",
    }),
  );
});

// --- 4. Exchange, from the app's web view ------------------------------------
appSignIn.post("/exchange", async (c) => {
  noStore(c);
  const failed = () => c.redirect("/login?error=app_signin_failed", 302);
  if (await limited(c)) return failed();
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !PKCE_VERIFIER_PATTERN.test(verifier)) return failed();

  // Single use, atomically, as with the email link (routes/magic.ts).
  const row = await c.env.DB.prepare(
    `DELETE FROM auth_tokens WHERE id = ? AND kind = 'app_code' RETURNING data, expires_at`,
  )
    .bind(await sha256hex(code))
    .first<{ data: string | null; expires_at: number }>();
  const grant = row && row.expires_at > Date.now() ? parseCode(row.data) : null;
  if (!grant || !(await timingSafeEqual(await s256(verifier), grant.challenge))) return failed();

  // The web view's own session, rotated like every other sign-in.
  await endCurrentSession(c);
  await createSession(c, grant.identity, grant.identityKind);
  return c.redirect("/", 302);
});

function parsePending(raw: string | null): PendingSignIn | null {
  try {
    const v = JSON.parse(raw ?? "") as Partial<PendingSignIn>;
    if (typeof v.challenge === "string" && typeof v.state === "string" && typeof v.hadSession === "boolean") {
      return { challenge: v.challenge, state: v.state, hadSession: v.hadSession };
    }
  } catch {
    // An unreadable row is no sign-in.
  }
  return null;
}

const IDENTITY_KINDS: readonly IdentityKind[] = ["github", "email", "passkey", "hosted"];

function parseCode(raw: string | null): AppCode | null {
  try {
    const v = JSON.parse(raw ?? "") as Partial<AppCode>;
    if (
      typeof v.challenge === "string" &&
      typeof v.identity === "string" &&
      typeof v.identityKind === "string" &&
      IDENTITY_KINDS.includes(v.identityKind)
    ) {
      return { challenge: v.challenge, identity: v.identity, identityKind: v.identityKind };
    }
  } catch {
    // As above.
  }
  return null;
}
