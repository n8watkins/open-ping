/**
 * app.<domain>: sign-up, sign-in (email link and code, passkey, GitHub),
 * the account page, choosing an address (which starts provisioning), and
 * the hand-off into the customer's own OpenPing.
 *
 * Every state-changing request is a POST that must come from this origin
 * (the Origin header, or Sec-Fetch-Site same-origin when the browser sends
 * none), on top of SameSite=Lax cookies. Pages carry no inline script; the passkey helper is the only one.
 */

import { Hono, type Context } from "hono";

import { ADMIN_NEXT_PATTERN } from "./admin/routes";
import { isOwner, mayChangePasskeys } from "./admin/owner";
import { supportSignIns } from "./admin/data";
import { WebAuthnError, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "../../src/worker/lib/webauthn";
import { TERMS_VERSION } from "./legal/documents";
import { LEGAL_PATHS, legalPage } from "./legal/pages";
import { accountForVerifiedEmail, audit, findAccountByEmail, getAccount, isDisposableEmail, normalizeEmail, touchIdentity, type Account } from "./accounts";
import {
  accountPage,
  checkEmailPage,
  confirmLinkPage,
  continuePage,
  deleteAccountPage,
  emailChangeCodePage,
  emailChangeConfirmPage,
  emailChangePage,
  homePage,
  messagePage,
  signInPage,
  signOutPage,
  startPage,
  type AccountTenantView,
} from "./account-pages";
import { clearCeremonyCookie, startCeremony, takeCeremony } from "./auth/ceremonies";
import { checkEmailCode, consumeEmailLink, createEmailSignIn, decoyLoginId, emailOfSignIn, passkeyAddedEmail, signInEmail } from "./auth/email-sign-in";
import { authorizeUrl, codeChallenge, fetchGithubUser, githubConfig, newCodeVerifier, newOAuthState, type GithubUser } from "./auth/github";
import {
  MAX_PASSKEYS,
  addPasskey,
  ensureWebauthnHandle,
  listPasskeys,
  newChallenge,
  passkeyLabel,
  registrationOptions,
  removePasskey,
  signInOptions,
  verifyPasskeySignIn,
  type PasskeyExpectation,
} from "./auth/passkeys";
import { LIMITS, hitInOrder, ipSubject, isOverLimit } from "./auth/rate-limit";
import { applyEmailChange, checkEmailChangeCode, consumeEmailChangeLink, emailChangeByToken, startEmailChange, type EmailChangeCheck } from "./auth/email-change";
import { freshSignIn } from "./auth/fresh";
import { requestAccountDeletion } from "./account-deletion";
import { emailChangeCodeEmail, emailChangedEmail } from "./emails";
import { SESSION_COOKIE, createSession, endSession, readSession, type Session, type SignInMethod } from "./auth/sessions";
import { clearCookie } from "./auth/cookies";
import { PASSKEY_SCRIPT, PASSKEY_SCRIPT_PATH } from "./client-script";
import type { PlatformEnv } from "./env";
import { handoffUrl, mintHandoffToken } from "./handoff";
import { requestAppOrigin, requestTenantOrigin } from "./hosts";
import { PLATFORM_REPLY_TO, type Mailer } from "./mail";
import { requestTenant, runProvisioning } from "./provisioning";
import type { ProvisioningSetup } from "./provisioning-env";
import { enqueueProvisioning } from "./provisioning-queue";
import { SLUG_MESSAGES, checkSlugAvailability } from "./slugs";
import { tenantFromRow, type TenantRecord } from "./tenants";
import { billingSetup, type BillingSetup } from "./billing/config";
import { billingView, registerBillingRoutes } from "./billing/routes";
import { log } from "./log";
import { SUPPORT_EMAIL } from "./ui";

export interface AccountDeps {
  /** The platform's mailer, or null while mail isn't configured. */
  mailer(env: PlatformEnv): Mailer | null;
  /** Provisioning, for the tenant a new account creates. */
  provisioning(env: PlatformEnv, ctx: ExecutionContext): ProvisioningSetup;
  /** Billing (B5): Stripe and its settings, or what is missing; by default from the env. */
  billing?: (env: PlatformEnv) => BillingSetup;
  /** For GitHub's OAuth calls; the global fetch in production. */
  fetch?: typeof fetch;
  now?: () => number;
}

type Env = { Bindings: PlatformEnv; Variables: { session: Session | null; now: number } };
type Ctx = Context<Env>;

const NO_STORE = { "cache-control": "no-store" } as const;

/** Where a sign-in may send the browser afterwards: only these local paths. */
const NEXT_PATTERN = /^\/(?:account|account\/export|start|billing|billing\/upgrade|open\?tenant=[a-z][a-z0-9-]{1,29})$/;

export function safeNext(value: unknown): string | null {
  return typeof value === "string" && (NEXT_PATTERN.test(value) || ADMIN_NEXT_PATTERN.test(value)) ? value : null;
}

/** The sign-in page's `?tenant=<slug>` (from a tenant's signIn URL) becomes a next path. */
function nextFromQuery(c: Ctx): string | null {
  const tenant = c.req.query("tenant");
  if (tenant) return safeNext(`/open?tenant=${tenant}`);
  return safeNext(c.req.query("next"));
}

/** This page's origin: https://app.<domain> in production, the request's own in local development. */
const origin = (c: Ctx) => requestAppOrigin(c.req.url, c.env.HOSTED_DOMAIN);

const originOfTenant = (c: Ctx, slug: string) => requestTenantOrigin(c.req.url, slug, c.env.HOSTED_DOMAIN);

function passkeyExpectation(c: Ctx): PasskeyExpectation {
  const url = new URL(origin(c));
  return { origin: url.origin, rpId: url.hostname };
}

/** The per-IP limit subject: the address, or an IPv6 address's /64. */
function clientIp(c: Ctx): string {
  return ipSubject(c.req.header("cf-connecting-ip"));
}

const signUpsOpen = (env: PlatformEnv) => env.SIGN_UPS === "open";

/** What a new account accepts: the Terms the sign-up and sign-in pages link (src/legal/), or nothing while sign-ups are closed. */
const accountCreation = (env: PlatformEnv) => (signUpsOpen(env) ? { termsVersion: TERMS_VERSION } : null);

/** A 303 to `location`, setting `cookies`. */
function seeOther(_c: Ctx, location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function withCookies(response: Response, cookies: string[]): Response {
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

async function formField(c: Ctx, name: string): Promise<string> {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const value = (form as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

async function form(c: Ctx): Promise<Record<string, string>> {
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

const tooMany = () => "Too many tries. Please wait a few minutes and try again.";

interface TenantRow {
  id: string;
  account_id: string;
  slug: string;
  script_name: string;
  status: string;
  owner_suspended_at: number | null;
  plan: string;
  provision_state: string;
  version: string | null;
  limit_overrides: string | null;
  trial_ends_at: number | null;
  provision_attempts: number;
  provision_paused_at: number | null;
  billing_reason: string | null;
}

async function accountTenant(
  db: D1Database,
  accountId: string,
): Promise<(TenantRecord & { attempts: number; paused: boolean; billingReason: string | null }) | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, slug, script_name, status, owner_suspended_at, plan, provision_state, version, limit_overrides, trial_ends_at, provision_attempts,
              provision_paused_at, billing_reason
       FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1`,
    )
    .bind(accountId)
    .first<TenantRow>();
  return row
    ? { ...tenantFromRow(row), attempts: row.provision_attempts, paused: row.provision_paused_at !== null, billingReason: row.billing_reason }
    : null;
}

export function accountRoutes(deps: AccountDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? Date.now;
  const billing = deps.billing ?? ((env: PlatformEnv) => billingSetup(env));

  app.use("*", async (c, next) => {
    c.set("now", now());
    c.set("session", await readSession(c.env.PLATFORM_DB, c.req.raw, c.get("now")));
    // A form or JSON post from another site never changes anything here.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const from = c.req.header("origin");
      const sameSite = c.req.header("sec-fetch-site");
      const own = new URL(c.req.url).origin;
      // Browsers send `Origin: null` from a page whose referrer policy hides it; then Sec-Fetch-Site decides.
      const ok = from && from !== "null" ? from === own : sameSite === "same-origin";
      if (!ok) {
        return c.json({ error: "forbidden", message: "This request didn't come from OpenPing Hosted." }, 403, NO_STORE);
      }
    }
    await next();
  });

  /** Starts a session for `account` and sends the browser on. */
  async function signedIn(c: Ctx, account: Account, method: SignInMethod, next: string | null, extraCookies: string[] = []): Promise<Response> {
    // Any session this browser already had ends; it never keeps two.
    await endSession(c.env.PLATFORM_DB, c.req.raw);
    const cookie = await createSession(c.env.PLATFORM_DB, account.id, method, c.get("now"));
    await audit(c.env.PLATFORM_DB, { accountId: account.id, actor: "customer", action: "account.signed_in", detail: { method }, now: c.get("now") });
    // On to the customer's OpenPing: /open hands off to another origin, which
    // the CSP's form-action blocks at the end of a chain of redirects from a
    // post (the email code and link forms). A page that goes on by GET isn't.
    const slug = next?.startsWith("/open?tenant=") ? next.slice("/open?tenant=".length) : null;
    if (slug && c.req.method === "POST") {
      return withCookies(
        continuePage({ href: next!, title: "You're signed in", body: "Opening your OpenPing.", label: `Continue to ${slug}` }),
        [cookie, ...extraCookies],
      );
    }
    return seeOther(c, next ?? "/account", [cookie, ...extraCookies]);
  }

  /** The finished sign-in for a verified email, or the page that says why it can't be. */
  async function emailVerified(c: Ctx, email: string, next: string | null): Promise<Response> {
    const found = await accountForVerifiedEmail(c.env.PLATFORM_DB, email, c.get("now"), accountCreation(c.env));
    if (!found) {
      return messagePage({
        title: "Sign-ups aren't open yet",
        body: "There's no OpenPing Hosted account for this address, and new accounts can't be made yet. Join the waitlist on openping.n8builds.dev to hear when they can.",
        status: 403,
        action: { href: "https://openping.n8builds.dev/#pricing", label: "Join the waitlist" },
      });
    }
    if (found.account.disabledAt !== null) return disabledPage();
    await touchIdentity(c.env.PLATFORM_DB, found.account.id, "email", email, c.get("now"));
    if (found.created) {
      await audit(c.env.PLATFORM_DB, { accountId: found.account.id, actor: "customer", action: "account.created", detail: { method: "email", termsVersion: TERMS_VERSION }, now: c.get("now") });
    }
    return signedIn(c, found.account, "email", next);
  }

  const disabledPage = () =>
    messagePage({ title: "This account is closed", body: "Write to support@n8builds.dev if you think this is a mistake.", status: 403 });

  // --- Pages -----------------------------------------------------------------

  app.get("/", (c) => (c.get("session") ? seeOther(c, "/account") : homePage({ signUpsOpen: signUpsOpen(c.env) })));

  for (const mode of ["sign-in", "sign-up"] as const) {
    app.get(`/${mode}`, (c) => {
      const next = nextFromQuery(c);
      if (c.get("session")) return seeOther(c, next ?? "/account");
      return signInPage({
        mode,
        next,
        mailOn: deps.mailer(c.env) !== null,
        githubOn: githubConfig(c.env) !== null,
        signUpsOpen: signUpsOpen(c.env),
      });
    });
  }

  // The Terms and the Privacy Policy (src/legal/), signed in or not.
  app.get(LEGAL_PATHS.terms, () => legalPage("terms"));
  app.get(LEGAL_PATHS.privacy, () => legalPage("privacy"));

  app.get(PASSKEY_SCRIPT_PATH, () =>
    new Response(PASSKEY_SCRIPT, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
    }),
  );

  // --- Email: a link and a code ---------------------------------------------

  app.post("/sign-in/email", async (c) => {
    const fields = await form(c);
    const mode = fields.mode === "sign-up" ? "sign-up" : "sign-in";
    const next = safeNext(fields.next);
    const page = (error: string, status = 400, email = fields.email ?? "") =>
      signInPage({ mode, next, error, email, status, mailOn: true, githubOn: githubConfig(c.env) !== null, signUpsOpen: signUpsOpen(c.env) });

    const mailer = deps.mailer(c.env);
    if (!mailer) return page("Email sign-in isn't available right now. Please try GitHub or a passkey.", 503);
    const email = normalizeEmail(fields.email);
    if (!email) return page("Enter an email address like you@example.com.");
    if (isDisposableEmail(email)) return page("Please use a permanent email address. Throwaway addresses can't hold an account.");
    const limited = await hitInOrder(
      c.env.PLATFORM_DB,
      [
        [LIMITS.emailPerAddress, email],
        [LIMITS.emailPerIp, clientIp(c)],
        [LIMITS.emailGlobal, "all"],
      ],
      c.get("now"),
    );
    if (limited) return page(tooMany(), 429);

    const existing = await findAccountByEmail(c.env.PLATFORM_DB, email);
    // Sign-ups closed and no account: the same page as always, but nothing is
    // sent, so the form says nothing about which addresses have accounts and
    // mails nobody who can't sign in.
    if (!existing && !signUpsOpen(c.env)) return checkEmailPage({ email, loginId: decoyLoginId() });
    const started = await createEmailSignIn(c.env.PLATFORM_DB, { email, nextPath: next, now: c.get("now") });
    const link = `${origin(c)}/sign-in/link?token=${encodeURIComponent(started.token)}`;
    const message = signInEmail({ code: started.code, link, newAccount: !existing });
    const sent = await mailer.send({ to: email, ...message, category: "signin", replyTo: PLATFORM_REPLY_TO });
    if (!sent.ok) {
      log.error("signin.email_not_sent", { error: sent.error });
      return page("We couldn't send the email just now. Please try again in a minute.", 502);
    }
    return checkEmailPage({ email, loginId: started.loginId });
  });

  app.post("/sign-in/code", async (c) => {
    const fields = await form(c);
    const loginId = fields.login ?? "";
    const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.codePerIp, clientIp(c)]], c.get("now"));
    if (limited) return messagePage({ title: "Too many tries", body: tooMany(), status: 429, action: { href: "/sign-in", label: "Back to sign in" } });
    const email = await emailOfSignIn(c.env.PLATFORM_DB, loginId, c.get("now"));
    // Too many wrong codes for this address today, across every sign-in: only the link works now.
    if (email && (await isOverLimit(c.env.PLATFORM_DB, LIMITS.codeFailuresPerAddress, email, c.get("now")))) {
      return messagePage({
        title: "Use the link in your email",
        body: "There have been too many wrong codes for this address today, so codes are off until tomorrow. The link in your latest email still works.",
        status: 429,
      });
    }
    const result = await checkEmailCode(c.env.PLATFORM_DB, loginId, fields.code ?? "", c.get("now"));
    if (result.ok) return emailVerified(c, result.email, safeNext(result.nextPath));
    if (result.reason === "wrong_code") {
      await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.codeFailuresPerAddress, result.email]], c.get("now"));
      if (result.remaining > 0) {
        return checkEmailPage({
          email: result.email,
          loginId,
          status: 400,
          error: `That code isn't right. ${result.remaining === 1 ? "1 try left." : `${result.remaining} tries left.`}`,
        });
      }
    }
    return messagePage({
      title: "This code has expired",
      body: "Codes work for 15 minutes and a few tries. Ask for a new one and use the latest email.",
      status: 400,
      action: { href: "/sign-in", label: "Get a new code" },
    });
  });

  // A GET only shows a button, so a mail scanner that opens every link can't use it up.
  app.get("/sign-in/link", (c) => {
    const token = c.req.query("token") ?? "";
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return linkExpired();
    return confirmLinkPage(token);
  });

  const linkExpired = () =>
    messagePage({
      title: "This sign-in link has expired",
      body: "Links work once, for 15 minutes. Ask for a new one and use the latest email.",
      status: 400,
      action: { href: "/sign-in", label: "Get a new link" },
    });

  app.post("/sign-in/link", async (c) => {
    const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.linkPerIp, clientIp(c)]], c.get("now"));
    if (limited) return messagePage({ title: "Too many tries", body: tooMany(), status: 429 });
    const result = await consumeEmailLink(c.env.PLATFORM_DB, await formField(c, "token"), c.get("now"));
    if (!result) return linkExpired();
    return emailVerified(c, result.email, safeNext(result.nextPath));
  });

  // --- Passkeys ------------------------------------------------------------

  app.post("/sign-in/passkey/options", async (c) => {
    // Each call stores a ceremony, so anonymous callers are limited too (apart from finishing, so starts can't use that up).
    const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.passkeyStartPerIp, clientIp(c)]], c.get("now"));
    if (limited) return c.json({ error: "rate_limited", message: tooMany() }, 429, NO_STORE);
    const body = (await c.req.json().catch(() => ({}))) as { next?: unknown };
    const challenge = newChallenge();
    const cookie = await startCeremony(c.env.PLATFORM_DB, {
      kind: "passkey_sign_in",
      challenge,
      accountId: null,
      nextPath: safeNext(body.next),
      now: c.get("now"),
    });
    return withCookies(c.json(signInOptions({ challenge, rpId: passkeyExpectation(c).rpId }), 200, NO_STORE), [cookie]);
  });

  app.post("/sign-in/passkey", async (c) => {
    const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.passkeyPerIp, clientIp(c)]], c.get("now"));
    if (limited) return c.json({ error: "rate_limited", message: tooMany() }, 429, NO_STORE);
    const ceremony = await takeCeremony(c.env.PLATFORM_DB, c.req.raw, "passkey_sign_in", c.get("now"));
    if (!ceremony) return c.json({ error: "expired", message: "That took too long. Please try again." }, 400, NO_STORE);
    const body = (await c.req.json().catch(() => ({}))) as { credential?: AuthenticationResponseJSON };
    let signer: { accountId: string; credentialId: string };
    try {
      signer = await verifyPasskeySignIn(c.env.PLATFORM_DB, {
        credential: body.credential as AuthenticationResponseJSON,
        challenge: ceremony.challenge,
        expect: passkeyExpectation(c),
        now: c.get("now"),
      });
    } catch (error) {
      if (!(error instanceof WebAuthnError) && !(error instanceof TypeError)) throw error;
      return withCookies(c.json({ error: "passkey_refused", message: "That passkey isn't on an OpenPing Hosted account. Try email instead." }, 400, NO_STORE), [clearCeremonyCookie()]);
    }
    const account = await getAccount(c.env.PLATFORM_DB, signer.accountId);
    if (!account || account.disabledAt !== null) return c.json({ error: "disabled", message: "This account is closed." }, 403, NO_STORE);
    await endSession(c.env.PLATFORM_DB, c.req.raw);
    const session = await createSession(c.env.PLATFORM_DB, account.id, "passkey", c.get("now"), signer.credentialId);
    await audit(c.env.PLATFORM_DB, { accountId: account.id, actor: "customer", action: "account.signed_in", detail: { method: "passkey" }, now: c.get("now") });
    return withCookies(c.json({ ok: true, redirect: ceremony.nextPath ?? "/account" }, 200, NO_STORE), [session, clearCeremonyCookie()]);
  });

  /** The owner's passkeys change only from a recent pinned passkey sign-in (admin/owner.ts, mayChangePasskeys). */
  const passkeysLocked = (c: Ctx) =>
    c.json(
      { error: "passkey_locked", message: "Sign in with one of your pinned passkeys first; passkeys on this account change only within 10 minutes of that." },
      403,
      NO_STORE,
    );

  /**
   * Adding or removing a way to sign in needs what changing the email does
   * (./auth/fresh.ts): otherwise a stale session could add its own passkey,
   * sign in with it, and pass every "sign in again" check after that.
   */
  const signInStale = (c: Ctx, session: Session) => freshSignIn(c.env.PLATFORM_DB, session, c.get("now")).then((f) => (f.fresh ? null : f));
  const staleJson = (c: Ctx, hasPasskey: boolean) =>
    c.json(
      {
        error: "sign_in_again",
        message: hasPasskey
          ? "To change how you sign in, sign in again with your passkey first."
          : "To change how you sign in, sign in again first: it has been more than 15 minutes.",
      },
      401,
      NO_STORE,
    );

  app.post("/account/passkeys/options", async (c) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "signed_out", message: "Please sign in again." }, 401, NO_STORE);
    if (!(await mayChangePasskeys(c.env.PLATFORM_DB, session, c.env, c.get("now")))) return passkeysLocked(c);
    const stale = await signInStale(c, session);
    if (stale) return staleJson(c, stale.hasPasskey);
    const existing = await listPasskeys(c.env.PLATFORM_DB, session.account.id);
    if (existing.length >= MAX_PASSKEYS) {
      return c.json({ error: "too_many", message: `An account can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` }, 400, NO_STORE);
    }
    const handle = await ensureWebauthnHandle(c.env.PLATFORM_DB, session.account);
    const challenge = newChallenge();
    const cookie = await startCeremony(c.env.PLATFORM_DB, { kind: "passkey_register", challenge, accountId: session.account.id, nextPath: null, now: c.get("now") });
    const options = registrationOptions({ challenge, rpId: passkeyExpectation(c).rpId, handle, email: session.account.email, existing });
    return withCookies(c.json(options, 200, NO_STORE), [cookie]);
  });

  app.post("/account/passkeys", async (c) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "signed_out", message: "Please sign in again." }, 401, NO_STORE);
    if (!(await mayChangePasskeys(c.env.PLATFORM_DB, session, c.env, c.get("now")))) return passkeysLocked(c);
    const staleNow = await signInStale(c, session);
    if (staleNow) return staleJson(c, staleNow.hasPasskey);
    const ceremony = await takeCeremony(c.env.PLATFORM_DB, c.req.raw, "passkey_register", c.get("now"));
    if (!ceremony || ceremony.accountId !== session.account.id) {
      return c.json({ error: "expired", message: "That took too long. Please try again." }, 400, NO_STORE);
    }
    const body = (await c.req.json().catch(() => ({}))) as { credential?: RegistrationResponseJSON; name?: unknown };
    const label = passkeyLabel(body.name ?? c.req.header("sec-ch-ua-platform")?.replace(/"/g, ""));
    try {
      await addPasskey(c.env.PLATFORM_DB, {
        account: session.account,
        credential: body.credential as RegistrationResponseJSON,
        challenge: ceremony.challenge,
        expect: passkeyExpectation(c),
        label,
        now: c.get("now"),
      });
    } catch (error) {
      if (!(error instanceof WebAuthnError) && !(error instanceof TypeError)) throw error;
      return withCookies(c.json({ error: "passkey_refused", message: "That passkey couldn't be added. Please try again." }, 400, NO_STORE), [clearCeremonyCookie()]);
    }
    await audit(c.env.PLATFORM_DB, { accountId: session.account.id, actor: "customer", action: "passkey.added", now: c.get("now") });
    // Always told: a passkey added by someone who got into the inbox is the first thing to notice.
    const mailer = deps.mailer(c.env);
    if (mailer) {
      const sent = await mailer.send({
        to: session.account.email,
        ...passkeyAddedEmail({ label, at: c.get("now"), accountUrl: `${origin(c)}/account` }),
        category: "passkey_added",
        replyTo: PLATFORM_REPLY_TO,
      });
      if (!sent.ok) log.error("signin.passkey_notice_not_sent", { error: sent.error });
    }
    return withCookies(c.json({ ok: true, redirect: "/account?done=passkey" }, 200, NO_STORE), [clearCeremonyCookie()]);
  });

  app.post("/account/passkeys/:id/delete", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in");
    if (!(await mayChangePasskeys(c.env.PLATFORM_DB, session, c.env, c.get("now")))) return seeOther(c, "/account?done=passkey-locked");
    if (await signInStale(c, session)) return seeOther(c, "/account?done=sign-in-again");
    if (await removePasskey(c.env.PLATFORM_DB, session.account.id, c.req.param("id"))) {
      await audit(c.env.PLATFORM_DB, { accountId: session.account.id, actor: "customer", action: "passkey.removed", now: c.get("now") });
    }
    return seeOther(c, "/account?done=passkey-removed");
  });

  // --- GitHub ----------------------------------------------------------------

  const callbackUrl = (c: Ctx) => `${origin(c)}/auth/github/callback`;

  app.get("/auth/github", async (c) => {
    const config = githubConfig(c.env);
    if (!config) return messagePage({ title: "GitHub sign-in isn't available", body: "Please sign in with email instead.", status: 404, action: { href: "/sign-in", label: "Sign in with email" } });
    const session = c.get("session");
    const linking = c.req.query("link") === "1" && session !== null;
    if (linking && (await signInStale(c, session!))) return seeOther(c, "/account?done=sign-in-again");
    const state = newOAuthState();
    const verifier = newCodeVerifier();
    const cookie = await startCeremony(c.env.PLATFORM_DB, {
      kind: "github",
      challenge: state,
      verifier,
      accountId: linking ? session!.account.id : null,
      nextPath: linking ? "/account" : nextFromQuery(c),
      now: c.get("now"),
    });
    return seeOther(c, authorizeUrl(config, { redirectUri: callbackUrl(c), state, codeChallenge: await codeChallenge(verifier) }), [cookie]);
  });

  app.get("/auth/github/callback", async (c) => {
    const config = githubConfig(c.env);
    const failed = (body: string, status = 400) =>
      withCookies(messagePage({ title: "GitHub sign-in didn't work", body, status, action: { href: "/sign-in", label: "Back to sign in" } }), [clearCeremonyCookie()]);
    if (!config) return failed("GitHub sign-in isn't available. Please sign in with email instead.", 404);
    const limited = await hitInOrder(c.env.PLATFORM_DB, [[LIMITS.githubPerIp, clientIp(c)]], c.get("now"));
    if (limited) return failed(tooMany(), 429);
    const ceremony = await takeCeremony(c.env.PLATFORM_DB, c.req.raw, "github", c.get("now"));
    const state = c.req.query("state") ?? "";
    if (!ceremony || state.length !== ceremony.challenge.length || state !== ceremony.challenge) {
      return failed("That sign-in started somewhere else or took too long. Please try again.");
    }
    const code = c.req.query("code");
    if (!code) return failed("GitHub didn't sign you in. Please try again, or use email.");
    let user: GithubUser;
    try {
      if (!ceremony.verifier) return failed("That sign-in started somewhere else or took too long. Please try again.");
      user = await fetchGithubUser(config, { code, redirectUri: callbackUrl(c), codeVerifier: ceremony.verifier }, deps.fetch);
    } catch (error) {
      log.error("signin.github_failed", { error });
      return failed("We couldn't reach GitHub. Please try again in a minute.", 502);
    }
    return githubSignedIn(c, user, ceremony.accountId, safeNext(ceremony.nextPath));
  });

  async function githubSignedIn(c: Ctx, user: GithubUser, linkTo: string | null, next: string | null): Promise<Response> {
    const db = c.env.PLATFORM_DB;
    const t = c.get("now");
    const identity = await db
      .prepare("SELECT account_id FROM account_identities WHERE kind = 'github' AND subject = ?")
      .bind(user.id)
      .first<{ account_id: string }>();

    // Connecting GitHub from the account page.
    if (linkTo) {
      if (identity && identity.account_id !== linkTo) {
        return seeOther(c, "/account?done=github-taken", [clearCeremonyCookie()]);
      }
      await db
        .prepare(
          `INSERT INTO account_identities (id, account_id, kind, subject, label, created_at) VALUES (?, ?, 'github', ?, ?, ?)
           ON CONFLICT(kind, subject) DO UPDATE SET label = excluded.label`,
        )
        .bind(`idn_${crypto.randomUUID()}`, linkTo, user.id, user.login, t)
        .run();
      await audit(db, { accountId: linkTo, actor: "customer", action: "github.linked", detail: { login: user.login }, now: t });
      return seeOther(c, "/account?done=github", [clearCeremonyCookie()]);
    }

    let account: Account | null = identity ? await getAccount(db, identity.account_id) : null;
    if (!account) {
      // Joined to an account (or a new one) only by the verified primary address.
      if (!user.email) {
        return withCookies(
          messagePage({
            title: "Your GitHub account has no verified email",
            body: "Add and verify a primary email on GitHub, or sign in with email here instead.",
            status: 400,
            action: { href: "/sign-in", label: "Sign in with email" },
          }),
          [clearCeremonyCookie()],
        );
      }
      // A new account from GitHub gets the same throwaway-address check as one from the email form.
      if (isDisposableEmail(user.email) && !(await findAccountByEmail(db, user.email))) {
        return withCookies(
          messagePage({
            title: "Please use a permanent email address",
            body: "Your GitHub account's primary email is a throwaway address, which can't hold an account. Change it on GitHub, or sign up with email here.",
            status: 400,
            action: { href: "/sign-up", label: "Sign up with email" },
          }),
          [clearCeremonyCookie()],
        );
      }
      const found = await accountForVerifiedEmail(db, user.email, t, accountCreation(c.env));
      if (!found) {
        return withCookies(
          messagePage({
            title: "Sign-ups aren't open yet",
            body: "There's no OpenPing Hosted account for your GitHub email, and new accounts can't be made yet.",
            status: 403,
            action: { href: "https://openping.n8builds.dev/#pricing", label: "Join the waitlist" },
          }),
          [clearCeremonyCookie()],
        );
      }
      account = found.account;
      await db
        .prepare(
          `INSERT INTO account_identities (id, account_id, kind, subject, label, created_at) VALUES (?, ?, 'github', ?, ?, ?)
           ON CONFLICT(kind, subject) DO NOTHING`,
        )
        .bind(`idn_${crypto.randomUUID()}`, account.id, user.id, user.login, t)
        .run();
      if (found.created) await audit(db, { accountId: account.id, actor: "customer", action: "account.created", detail: { method: "github", termsVersion: TERMS_VERSION }, now: t });
    }
    if (account.disabledAt !== null) return withCookies(disabledPage(), [clearCeremonyCookie()]);
    await db
      .prepare("UPDATE account_identities SET label = ?, last_used_at = ? WHERE kind = 'github' AND subject = ?")
      .bind(user.login, t, user.id)
      .run();
    return signedIn(c, account, "github", next, [clearCeremonyCookie()]);
  }

  app.post("/account/github/unlink", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in");
    if (await signInStale(c, session)) return seeOther(c, "/account?done=sign-in-again");
    // Email always remains, so this never locks anyone out.
    await c.env.PLATFORM_DB.prepare("DELETE FROM account_identities WHERE account_id = ? AND kind = 'github'").bind(session.account.id).run();
    await audit(c.env.PLATFORM_DB, { accountId: session.account.id, actor: "customer", action: "github.unlinked", now: c.get("now") });
    return seeOther(c, "/account?done=github-removed");
  });

  // --- The account, its OpenPing, and the hand-off -------------------------

  const FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
    passkey: { message: "Passkey added. You can sign in with it next time.", tone: "ok" },
    "passkey-removed": { message: "Passkey removed.", tone: "ok" },
    "passkey-locked": { message: "Passkeys on this account change only within 10 minutes of signing in with a pinned passkey.", tone: "error" },
    github: { message: "GitHub connected.", tone: "ok" },
    "github-removed": { message: "GitHub disconnected.", tone: "ok" },
    "sign-in-again": { message: "To change how you sign in, sign in again first (with your passkey, if you have one).", tone: "error" },
    email: { message: "Your email is changed. Sign in with the new one from now on.", tone: "ok" },
    "github-taken": { message: "That GitHub account is already connected to another OpenPing Hosted account.", tone: "error" },
  };

  // --- Changing the sign-in email -------------------------------------------
  // A fresh sign-in first (./auth/fresh.ts), then a code or link sent to the
  // new address; the old address is told once it switched.

  /** The "sign in again" answer, or null when the session may change the email. */
  async function needsFreshSignIn(c: Ctx, session: Session): Promise<Response | null> {
    const { fresh, hasPasskey } = await freshSignIn(c.env.PLATFORM_DB, session, c.get("now"));
    if (fresh) return null;
    return messagePage({
      title: "Sign in again first",
      body: hasPasskey
        ? "Your email can sign in to your account, so we ask for a sign-in with your passkey from the last 15 minutes before changing it."
        : "Your email can sign in to your account, so we ask for a sign-in from the last 15 minutes before changing it.",
      status: 401,
      action: { href: "/sign-in?next=%2Faccount%2Femail", label: "Sign in again" },
    });
  }

  app.get("/account/email", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount%2Femail");
    return (await needsFreshSignIn(c, session)) ?? emailChangePage({ current: session.account.email });
  });

  app.post("/account/email", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount%2Femail");
    const stale = await needsFreshSignIn(c, session);
    if (stale) return stale;
    const db = c.env.PLATFORM_DB;
    const raw = (await form(c)).email ?? "";
    const page = (error: string, status = 400) => emailChangePage({ current: session.account.email, email: raw, error, status });
    const mailer = deps.mailer(c.env);
    if (!mailer) return page("Email isn't available right now. Please try again later.", 503);
    const email = normalizeEmail(raw);
    if (!email) return page("Enter an email address like you@example.com.");
    if (email === session.account.email) return page("That's already your email.");
    if (isDisposableEmail(email)) return page("Please use a permanent email address. Throwaway addresses can't hold an account.");
    const limited = await hitInOrder(
      db,
      [
        [LIMITS.emailChangePerAccount, session.account.id],
        [LIMITS.emailPerAddress, email],
      ],
      c.get("now"),
    );
    if (limited) return page(tooMany(), 429);
    const started = await startEmailChange(db, { accountId: session.account.id, newEmail: email, now: c.get("now") });
    // An address another account holds gets nothing, and the page reads the
    // same and comes back as fast (the lookup and the send happen after the
    // answer), so this form can't tell anyone which addresses have accounts.
    const link = `${origin(c)}/account/email/confirm?token=${encodeURIComponent(started.token)}`;
    c.executionCtx.waitUntil(
      (async () => {
        if (await findAccountByEmail(db, email)) return;
        const sent = await mailer.send({ to: email, ...emailChangeCodeEmail({ code: started.code, link }), category: "email_change", replyTo: PLATFORM_REPLY_TO });
        if (!sent.ok) log.error("account.email_change_not_sent", { error: sent.error });
      })().catch((error: unknown) => log.error("account.email_change_not_sent", { error })),
    );
    return emailChangeCodePage({ email, changeId: started.changeId });
  });

  // The link only shows a button: a mail scanner opening it changes nothing.
  app.get("/account/email/confirm", async (c) => {
    const session = c.get("session");
    const token = c.req.query("token") ?? "";
    if (!session) return seeOther(c, `/sign-in?next=${encodeURIComponent(`/account/email/confirm?token=${token}`)}`);
    const change = await emailChangeByToken(c.env.PLATFORM_DB, session.account.id, token, c.get("now"));
    if (!change) return emailChangeExpired();
    return emailChangeConfirmPage({ token, email: change.newEmail });
  });

  app.post("/account/email/confirm", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount%2Femail");
    const db = c.env.PLATFORM_DB;
    const now = c.get("now");
    const fields = await form(c);
    let check: EmailChangeCheck;
    if (fields.token) {
      check = await consumeEmailChangeLink(db, session.account.id, fields.token, now);
    } else {
      if (await hitInOrder(db, [[LIMITS.codePerIp, clientIp(c)]], now)) return messagePage({ title: "Too many tries", body: tooMany(), status: 429, action: { href: "/account", label: "Back to your account" } });
      check = await checkEmailChangeCode(db, session.account.id, fields.change ?? "", fields.code ?? "", now);
      if (!check.ok && check.reason === "wrong_code" && check.remaining > 0) {
        return emailChangeCodePage({
          email: check.newEmail,
          changeId: fields.change ?? "",
          status: 400,
          error: `That code isn't right. ${check.remaining === 1 ? "1 try left." : `${check.remaining} tries left.`}`,
        });
      }
    }
    if (!check.ok) return emailChangeExpired();
    const oldEmail = session.account.email;
    const applied = await applyEmailChange(db, { accountId: session.account.id, oldEmail, newEmail: check.newEmail, keepSessionHash: session.tokenHash, now });
    if (applied === "stale") return emailChangeExpired();
    if (applied === "taken") {
      return messagePage({
        title: "That address has its own account",
        body: `${check.newEmail} signed up for OpenPing Hosted meanwhile, so it can't be this account's email. Write to ${SUPPORT_EMAIL} if you need the two joined.`,
        status: 409,
        action: { href: "/account", label: "Back to your account" },
      });
    }
    await audit(db, { accountId: session.account.id, actor: "customer", action: "account.email_changed", detail: { from: oldEmail, to: check.newEmail }, now });
    // Stripe's receipts follow; never fatal, the next change or the owner can fix it.
    const stripeCustomer = await db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(session.account.id).first<{ stripe_customer_id: string | null }>();
    const setup = billing(c.env);
    if (stripeCustomer?.stripe_customer_id && setup.ok) {
      await setup.stripe
        .updateCustomerEmail(stripeCustomer.stripe_customer_id, check.newEmail, `email-change-${session.account.id}-${now}`)
        .catch((error: unknown) => log.error("billing.customer_email_not_updated", { account: session.account.id, error }));
    }
    const mailer = deps.mailer(c.env);
    if (mailer) {
      const sent = await mailer.send({ to: oldEmail, ...emailChangedEmail({ newEmail: check.newEmail, at: now }), category: "email_changed", replyTo: PLATFORM_REPLY_TO });
      if (!sent.ok) log.error("account.email_changed_notice_not_sent", { error: sent.error });
    }
    return seeOther(c, "/account?done=email");
  });

  const emailChangeExpired = () =>
    messagePage({
      title: "This code has expired",
      body: "Codes and links work once, for 15 minutes, while you're signed in to the account that asked. Nothing was changed.",
      status: 400,
      action: { href: "/account/email", label: "Start again" },
    });

  // --- Deleting the account ----------------------------------------------------
  // A fresh sign-in and the typed email, then src/account-deletion.ts.

  async function deletionPage(c: Ctx, session: Session, error?: string) {
    const db = c.env.PLATFORM_DB;
    const tenant = await accountTenant(db, session.account.id);
    const paid = await db
      .prepare("SELECT 1 AS x FROM subscriptions WHERE account_id = ? AND status NOT IN ('canceled', 'incomplete_expired') LIMIT 1")
      .bind(session.account.id)
      .first();
    return deleteAccountPage({ email: session.account.email, hasOpenPing: tenant !== null, paid: paid !== null, error, status: error ? 400 : 200 });
  }

  async function needsFreshForDeletion(c: Ctx, session: Session): Promise<Response | null> {
    const { fresh, hasPasskey } = await freshSignIn(c.env.PLATFORM_DB, session, c.get("now"));
    if (fresh) return null;
    return messagePage({
      title: "Sign in again first",
      body: hasPasskey
        ? "Deleting your account can't be undone, so we ask for a sign-in with your passkey from the last 15 minutes first."
        : "Deleting your account can't be undone, so we ask for a sign-in from the last 15 minutes first.",
      status: 401,
      action: { href: "/sign-in?next=%2Faccount%2Fdelete", label: "Sign in again" },
    });
  }

  app.get("/account/delete", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount%2Fdelete");
    return (await needsFreshForDeletion(c, session)) ?? deletionPage(c, session);
  });

  app.post("/account/delete", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount%2Fdelete");
    const stale = await needsFreshForDeletion(c, session);
    if (stale) return stale;
    const typed = ((await form(c)).confirm ?? "").trim().toLowerCase();
    if (typed !== session.account.email) return deletionPage(c, session, "Type your account's email exactly, to show you mean it.");
    const setup = billing(c.env);
    const result = await requestAccountDeletion(
      { db: c.env.PLATFORM_DB, stripe: setup.ok ? setup.stripe : null, mailer: deps.mailer(c.env), now: c.get("now") },
      { accountId: session.account.id, by: "customer", actorAccountId: session.account.id },
    );
    const settled = !result.ok || result.billingSettled;
    return withCookies(
      messagePage({
        title: "Your account is being deleted",
        body: settled
          ? "You're signed out. We've emailed you what happens next, and we email again when it's done."
          : "You're signed out. Our payment provider didn't take the cancellation of your plan just now; we keep trying until it does, and refund anything it charges meanwhile. We've emailed you what happens next, and we email again when it's done.",
      }),
      [clearCookie(SESSION_COOKIE)],
    );
  });

  app.get("/account", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Faccount");
    const db = c.env.PLATFORM_DB;
    const tenant = await accountTenant(db, session.account.id);
    if (!tenant && !c.req.query("done")) return seeOther(c, "/start");
    const github = await db
      .prepare("SELECT label FROM account_identities WHERE account_id = ? AND kind = 'github' LIMIT 1")
      .bind(session.account.id)
      .first<{ label: string | null }>();
    const view: AccountTenantView | null = tenant
      ? {
          slug: tenant.slug,
          url: originOfTenant(c, tenant.slug),
          status: tenant.status,
          plan: tenant.plan,
          provisionState: tenant.provisionState,
          slow: tenant.attempts > 0,
          paused: tenant.paused,
          trialEndsAt: tenant.trialEndsAt,
          ownerSuspended: tenant.ownerSuspendedAt !== null,
          billingSuspended: tenant.billingStatus === "suspended",
        }
      : null;
    return accountPage({
      email: session.account.email,
      tenant: view,
      passkeys: await listPasskeys(db, session.account.id),
      github: github ? { login: github.label } : null,
      githubOn: githubConfig(c.env) !== null,
      flash: FLASH[c.req.query("done") ?? ""] ?? null,
      supportSignIns: tenant ? await supportSignIns(db, tenant.id) : [],
      isOwner: isOwner(session.account, c.env),
      billing: await billingView(db, session.account.id, billing(c.env).ok, c.get("now")),
      now: c.get("now"),
    });
  });

  app.get("/start", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Fstart");
    if (await accountTenant(c.env.PLATFORM_DB, session.account.id)) return seeOther(c, "/account");
    return startPage({ domain: c.env.HOSTED_DOMAIN, previousFailed: await lastProvisionFailed(c.env.PLATFORM_DB, session.account.id, c.get("now")) });
  });

  app.post("/start", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in?next=%2Fstart");
    const db = c.env.PLATFORM_DB;
    if (await accountTenant(db, session.account.id)) return seeOther(c, "/account");
    const slug = (await formField(c, "slug")).slice(0, 100);
    // The name first: a typo or a taken name costs nothing against the limits.
    const availability = await checkSlugAvailability(db, slug, c.get("now"));
    if (!availability.ok) return startPage({ domain: c.env.HOSTED_DOMAIN, slug, error: SLUG_MESSAGES[availability.reason], status: 400 });
    const limited = await hitInOrder(
      db,
      [
        [LIMITS.signUpPerIp, clientIp(c)],
        [LIMITS.signUpGlobal, "all"],
      ],
      c.get("now"),
    );
    if (limited) return startPage({ domain: c.env.HOSTED_DOMAIN, slug, error: tooMany(), status: 429 });
    let result: Awaited<ReturnType<typeof requestTenant>>;
    try {
      result = await requestTenant(db, { accountId: session.account.id, slug, now: c.get("now") });
    } catch (error) {
      // A second submit raced the first: one OpenPing per account (migration 0003), and it already has it.
      if (String(error).includes("UNIQUE") && String(error).includes("account_id")) return seeOther(c, "/account");
      throw error;
    }
    if (!result.ok) {
      // Taken by this very account a moment ago (a double tap): that is the customer's own name.
      if (result.reason === "taken" && (await accountTenant(db, session.account.id))?.slug === result.slug) return seeOther(c, "/account");
      return startPage({ domain: c.env.HOSTED_DOMAIN, slug, error: SLUG_MESSAGES[result.reason], status: 400 });
    }
    await audit(db, { accountId: session.account.id, tenantId: result.tenantId, actor: "customer", action: "tenant.requested", detail: { slug: result.slug }, now: c.get("now") });
    // Provisioning runs from the queue, where a run gets minutes instead of
    // waitUntil's 30 seconds; if neither is possible now, the cron picks it up.
    const setup = deps.provisioning(c.env, c.executionCtx as ExecutionContext);
    if (c.env.PROVISION_QUEUE) {
      await enqueueProvisioning(c.env.PROVISION_QUEUE, result.tenantId);
    } else if (setup.ok) {
      c.executionCtx.waitUntil(
        runProvisioning(setup.deps, result.tenantId, { force: true }).catch((error) => log.error("provision.first_run_failed", { tenant: result.tenantId, error })),
      );
    } else {
      log.warn("provision.off", { missing: setup.missing });
    }
    return seeOther(c, "/account");
  });

  app.get("/open", async (c) => {
    const slug = c.req.query("tenant") ?? "";
    const next = safeNext(`/open?tenant=${slug}`);
    const session = c.get("session");
    if (!session) return seeOther(c, next ? `/sign-in?tenant=${encodeURIComponent(slug)}` : "/sign-in");
    const tenant = next ? await accountTenant(c.env.PLATFORM_DB, session.account.id) : null;
    if (!tenant || tenant.slug !== slug) {
      return messagePage({ title: "That OpenPing isn't on your account", body: "Check the address, or open yours from your account page.", status: 404, action: { href: "/account", label: "Go to your account" } });
    }
    if (tenant.provisionState !== "ready" || tenant.status === "suspended") return seeOther(c, "/account");
    if (!c.env.HANDOFF_SIGNING_KEY) {
      log.error("signin.handoff_key_missing");
      return messagePage({ title: "Signing in to your OpenPing isn't available right now", body: "It has been logged. Please try again in a few minutes.", status: 503 });
    }
    const token = await mintHandoffToken(c.env.HANDOFF_SIGNING_KEY, {
      tenantId: tenant.id,
      accountId: session.account.id,
      email: session.account.email,
      now: c.get("now"),
    });
    await audit(c.env.PLATFORM_DB, { accountId: session.account.id, tenantId: tenant.id, actor: "customer", action: "handoff.issued", detail: { role: "customer" }, now: c.get("now") });
    const res = seeOther(c, handoffUrl(originOfTenant(c, tenant.slug), token));
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  });

  // The tenant's sign-out ends its own session, then sends the browser here
  // (contract, section 7). Signing out is a POST only, so no other site can
  // sign anyone out with a link or an image; the GET shows the button, and
  // goes straight to the page when there is no session to end.
  app.get("/sign-out", (c) =>
    c.get("session")
      ? signOutPage()
      : messagePage({ title: "You're signed out", body: "Sign in again whenever you need your OpenPing.", action: { href: "/sign-in", label: "Sign in" } }),
  );
  app.post("/sign-out", async (c) => {
    const cookie = await endSession(c.env.PLATFORM_DB, c.req.raw);
    return withCookies(messagePage({ title: "You're signed out", body: "Sign in again whenever you need your OpenPing.", action: { href: "/sign-in", label: "Sign in" } }), [cookie]);
  });

  // Billing (B5): /billing, /billing/upgrade, Checkout, the Customer Portal and the add-on.
  registerBillingRoutes(app, { billing });

  return app;
}

/** True when the account's last OpenPing failed to provision in the past day (start page notice). */
async function lastProvisionFailed(db: D1Database, accountId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM audit_events WHERE account_id = ? AND action = 'tenant.provision_failed' AND at > ? LIMIT 1")
    .bind(accountId, now - 86_400_000)
    .first();
  return row !== null;
}
