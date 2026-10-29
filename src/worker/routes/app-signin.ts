import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, IdentityKind } from "../types";
import { randomToken, sha256hex } from "../lib/ids";
import { createSession, destroySession, endCurrentSession, getSession } from "../lib/sessions";
import { hitRateLimit } from "../db/rate-limit";
import { timingSafeEqual } from "../lib/timing";
import { hostedProps } from "../lib/hosted";
import { renderPlainPage } from "../lib/plain-page";
import { getAdminEmail } from "../lib/admin";
import { getSetting } from "../db/settings";
import { sendEmail } from "../notifications/mail";
import { escapeHtml, renderEmailLayout, renderEmailText } from "../notifications/email-layout";
import {
  APP_REDIRECT_URI,
  APP_SIGNIN_PATHS,
  APP_STATE_PATTERN,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  androidPhone,
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
 *    That remembers the pair in this browser (a `__Host-` cookie naming a
 *    row) and goes on to the normal sign-in. Always a fresh one, even when
 *    the browser is signed in already, and only for a request the browser
 *    started itself (Sec-Fetch-Site: none, as from an app): a link on a web
 *    page can't start it.
 * 2. Every sign-in (GitHub, the email link, a passkey, the Hosted hand-off)
 *    ends at `afterSignInPath`, which sends a browser with that cookie to
 *    `GET /auth/app/finish` instead of the dashboard.
 * 3. finish shows "Open the OpenPing app": its link carries a one-time code
 *    (2 minutes) to the app's own scheme. A tap is needed, so a page someone
 *    else opened can't sign a phone in unseen, and Chrome only hands a
 *    redirect to an app after one.
 * 4. The app posts the code and its verifier from the web view to
 *    `POST /auth/app/exchange`, which checks the verifier against the
 *    challenge and starts the web view's own session (`via` "app", listed and
 *    revocable in Settings), and emails the admin that the app signed in.
 *
 * A code that some other app catches is useless without the verifier, which
 * never leaves the OpenPing app. The browser's own session, when the sign-in
 * made one, ends at step 3: the phone ends up signed in only in the app.
 *
 * What remains (docs/ANDROID.md, "Security"): a malicious app on the phone
 * that claims the same scheme could start the flow itself, with its own
 * verifier, and be handed the code if the person signs in and taps "Open the
 * OpenPing app" for it. The fresh sign-in, the tap, the email and the session
 * list in Settings are what stand in its way.
 */
export const appSignIn = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/**
 * `__Host-`: the browser only takes it from this exact origin, over https,
 * for "/", so no sibling subdomain (another Hosted customer) can plant one.
 */
export const PENDING_COOKIE = "__Host-op_app_signin";
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
  /** When it started: only a session made after this counts (a fresh sign-in). */
  startedAt: number;
  /** The session the browser had when it started, which never counts (its row id). */
  priorSession: string | null;
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
  return appSignInPending(c) ? APP_SIGNIN_PATHS.finish : "/";
}

/** True while this browser is signing in for the app (GitHub then asks which account, routes/auth.ts). */
export function appSignInPending(c: Ctx): boolean {
  return !!getCookie(c, PENDING_COOKIE);
}

/**
 * Whether the browser itself started this request: Sec-Fetch-Site "none" is
 * what an app opening a Custom Tab, a typed address or a bookmark sends; a link
 * or a form on any web page sends cross-site, same-site or same-origin. A
 * browser without Fetch Metadata sends nothing and is let through.
 */
export function browserInitiated(secFetchSite: string | undefined): boolean {
  return secFetchSite === undefined || secFetchSite === "none";
}

/**
 * Whether a post to /exchange may come from here: the app's web view
 * (WebView.postUrl sends no Origin, or "null", and Sec-Fetch-Site "none") or
 * this install's own page; never another site's form (login CSRF).
 */
export function exchangeAllowed(origin: string | undefined, secFetchSite: string | undefined, own: string): boolean {
  if (secFetchSite === "cross-site" || secFetchSite === "same-site") return false;
  return origin === undefined || origin === "null" || origin === own;
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
  // Only from the app: a link or a form on a web page (or in a page someone
  // sends you) can't start a sign-in for an app.
  if (!browserInitiated(c.req.header("sec-fetch-site"))) {
    return startAgainPage(
      c,
      "Start signing in from the app",
      "This sign-in for the OpenPing app didn't come from the app. Open the OpenPing app and tap Sign in there.",
      403,
    );
  }
  const challenge = c.req.query("challenge") ?? "";
  const state = c.req.query("state") ?? "";
  const method = c.req.query("challenge_method") ?? "S256";
  if (!PKCE_CHALLENGE_PATTERN.test(challenge) || !APP_STATE_PATTERN.test(state) || method !== "S256") {
    return startAgainPage(c, "This sign-in link isn't right", "It didn't come from the OpenPing app, or it was cut short.");
  }

  const session = await getSession(c);
  const now = Date.now();
  const pending: PendingSignIn = {
    challenge,
    state,
    hadSession: session !== null,
    startedAt: now,
    priorSession: session?.id ?? null,
  };
  const nonce = randomToken(24);
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

  // Always a fresh sign-in, even when this browser is signed in already: the
  // app gets a session only for someone who just proved it's them.
  // OpenPing Hosted signs its customers in on the platform (asked to sign in
  // again, `reauth=1`), which hands the browser back to /auth/hosted, which
  // ends at afterSignInPath.
  const hosted = hostedProps(c);
  if (hosted) {
    const signIn = new URL(hosted.tenant.urls.signIn);
    signIn.searchParams.set("reauth", "1");
    return c.redirect(signIn.toString(), 302);
  }
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
  // A session from before the app asked is not a fresh sign-in.
  if (session.id === pending.priorSession || session.created_at < pending.startedAt) {
    return startAgainPage(c, "Sign in again", "The app needs a new sign-in, made after you tapped Sign in in the app.", 403);
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
  // Never another site's form: that would sign the web view (or a browser)
  // in to someone else's session (login CSRF).
  if (!exchangeAllowed(c.req.header("origin"), c.req.header("sec-fetch-site"), new URL(c.req.url).origin)) {
    return failed();
  }
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
  await createSession(c, grant.identity, grant.identityKind, undefined, "app");
  const notice = sendAppSignInNotice(c).catch((e: unknown) => console.error("[app-signin] notice email failed", e));
  try {
    c.executionCtx.waitUntil(notice);
  } catch {
    await notice;
  }
  return c.redirect("/", 302);
});

/**
 * Tell the admin the app just signed in: if it wasn't them, Settings lists the
 * app's sessions to sign out. Best effort, like every sign-in email.
 */
async function sendAppSignInNotice(c: Ctx): Promise<void> {
  const to = await getAdminEmail(c.env);
  if (!to) return;
  const host = new URL(c.req.url).host;
  const phone = androidPhone(c.req.header("user-agent"));
  const device = phone ?? "an Android phone";
  const when = new Date().toUTCString();
  const settings = `${new URL(c.req.url).origin}/settings/security#sessions`;
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const p = (text: string) =>
    `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:#16233a;">${escapeHtml(text)}</p>`;
  const lines = [
    `The OpenPing app on ${device} signed in to ${host} (${when}).`,
    "If that was you, there is nothing to do.",
    "If it wasn't, open Settings > Sign-in & security on your OpenPing and sign that session out, or sign out everywhere.",
  ];
  await sendEmail(c.env, {
    from: (await getSetting(c.env, "email_from")) || "OpenPing <onboarding@resend.dev>",
    to,
    subject: "The OpenPing app signed in",
    html: renderEmailLayout({
      heading: "The OpenPing app signed in",
      accent: "neutral",
      bodyHtml: lines.map(p).join(""),
      button: { label: "Review sessions", url: settings },
      preheader: `The OpenPing app on ${device} signed in to ${host}.`,
    }),
    text: renderEmailText({ heading: "The OpenPing app signed in", lines: [...lines, "", settings] }),
    category: "signin",
  });
}

function parsePending(raw: string | null): PendingSignIn | null {
  try {
    const v = JSON.parse(raw ?? "") as Partial<PendingSignIn>;
    if (
      typeof v.challenge === "string" &&
      typeof v.state === "string" &&
      typeof v.hadSession === "boolean" &&
      typeof v.startedAt === "number"
    ) {
      return {
        challenge: v.challenge,
        state: v.state,
        hadSession: v.hadSession,
        startedAt: v.startedAt,
        priorSession: typeof v.priorSession === "string" ? v.priorSession : null,
      };
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
