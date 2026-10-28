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

import { WebAuthnError, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "../../src/worker/lib/webauthn";
import { accountForVerifiedEmail, audit, findAccountByEmail, getAccount, isDisposableEmail, normalizeEmail, touchIdentity, type Account } from "./accounts";
import {
  accountPage,
  checkEmailPage,
  confirmLinkPage,
  homePage,
  messagePage,
  signInPage,
  startPage,
  type AccountTenantView,
} from "./account-pages";
import { clearCeremonyCookie, startCeremony, takeCeremony } from "./auth/ceremonies";
import { checkEmailCode, consumeEmailLink, createEmailSignIn, signInEmail } from "./auth/email-sign-in";
import { authorizeUrl, fetchGithubUser, githubConfig, newOAuthState, type GithubUser } from "./auth/github";
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
import { LIMITS, hitAll } from "./auth/rate-limit";
import { createSession, endSession, readSession, type Session, type SignInMethod } from "./auth/sessions";
import { PASSKEY_SCRIPT, PASSKEY_SCRIPT_PATH } from "./client-script";
import type { PlatformEnv } from "./env";
import { handoffUrl, mintHandoffToken } from "./handoff";
import { appOrigin, tenantOrigin } from "./hosts";
import type { Mailer } from "./mail";
import { requestTenant, runProvisioning } from "./provisioning";
import type { ProvisioningSetup } from "./provisioning-env";
import { SLUG_MESSAGES } from "./slugs";
import { tenantFromRow, type TenantRecord } from "./tenants";

export interface AccountDeps {
  /** The platform's mailer, or null while mail isn't configured. */
  mailer(env: PlatformEnv): Mailer | null;
  /** Provisioning, for the tenant a new account creates. */
  provisioning(env: PlatformEnv, ctx: ExecutionContext): ProvisioningSetup;
  /** For GitHub's OAuth calls; the global fetch in production. */
  fetch?: typeof fetch;
  now?: () => number;
}

type Env = { Bindings: PlatformEnv; Variables: { session: Session | null; now: number } };
type Ctx = Context<Env>;

const NO_STORE = { "cache-control": "no-store" } as const;

/** Where a sign-in may send the browser afterwards: only these local paths. */
const NEXT_PATTERN = /^\/(?:account|start|open\?tenant=[a-z][a-z0-9-]{1,29})$/;

export function safeNext(value: unknown): string | null {
  return typeof value === "string" && NEXT_PATTERN.test(value) ? value : null;
}

/** The sign-in page's `?tenant=<slug>` (from a tenant's signIn URL) becomes a next path. */
function nextFromQuery(c: Ctx): string | null {
  const tenant = c.req.query("tenant");
  if (tenant) return safeNext(`/open?tenant=${tenant}`);
  return safeNext(c.req.query("next"));
}

/** This page's origin: https://app.<domain> in production, the request's own in local development. */
function origin(c: Ctx): string {
  const url = new URL(c.req.url);
  return url.protocol === "https:" ? appOrigin(c.env.HOSTED_DOMAIN) : url.origin;
}

function originOfTenant(c: Ctx, slug: string): string {
  const url = new URL(c.req.url);
  if (url.protocol === "https:") return tenantOrigin(slug, c.env.HOSTED_DOMAIN);
  return `${url.protocol}//${slug}.${url.host.replace(/^app\./, "")}`;
}

function passkeyExpectation(c: Ctx): PasskeyExpectation {
  const url = new URL(origin(c));
  return { origin: url.origin, rpId: url.hostname };
}

function clientIp(c: Ctx): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

const signUpsOpen = (env: PlatformEnv) => env.SIGN_UPS === "open";

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
  plan: string;
  provision_state: string;
  version: string | null;
  limit_overrides: string | null;
  trial_ends_at: number | null;
  provision_attempts: number;
}

async function accountTenant(db: D1Database, accountId: string): Promise<(TenantRecord & { attempts: number }) | null> {
  const row = await db
    .prepare(
      `SELECT id, account_id, slug, script_name, status, plan, provision_state, version, limit_overrides, trial_ends_at, provision_attempts
       FROM tenants WHERE account_id = ? AND provision_state <> 'deleting' ORDER BY created_at LIMIT 1`,
    )
    .bind(accountId)
    .first<TenantRow>();
  return row ? { ...tenantFromRow(row), attempts: row.provision_attempts } : null;
}

export function accountRoutes(deps: AccountDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? Date.now;

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
    const cookie = await createSession(c.env.PLATFORM_DB, account.id, method, c.get("now"));
    await audit(c.env.PLATFORM_DB, { accountId: account.id, actor: "customer", action: "account.signed_in", detail: { method }, now: c.get("now") });
    return seeOther(c, next ?? "/account", [cookie, ...extraCookies]);
  }

  /** The finished sign-in for a verified email, or the page that says why it can't be. */
  async function emailVerified(c: Ctx, email: string, next: string | null): Promise<Response> {
    const found = await accountForVerifiedEmail(c.env.PLATFORM_DB, email, c.get("now"), signUpsOpen(c.env));
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
      await audit(c.env.PLATFORM_DB, { accountId: found.account.id, actor: "customer", action: "account.created", detail: { method: "email" }, now: c.get("now") });
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
    const limited = await hitAll(
      c.env.PLATFORM_DB,
      [
        [LIMITS.emailPerAddress, email],
        [LIMITS.emailPerIp, clientIp(c)],
        [LIMITS.emailGlobal, "all"],
      ],
      c.get("now"),
    );
    if (limited) return page(tooMany(), 429);

    const started = await createEmailSignIn(c.env.PLATFORM_DB, { email, nextPath: next, now: c.get("now") });
    const link = `${origin(c)}/sign-in/link?token=${encodeURIComponent(started.token)}`;
    const existing = await findAccountByEmail(c.env.PLATFORM_DB, email);
    const message = signInEmail({ code: started.code, link, newAccount: !existing });
    const sent = await mailer.send({ to: email, ...message });
    if (!sent.ok) {
      console.error("[sign-in] email not sent", { error: sent.error });
      return page("We couldn't send the email just now. Please try again in a minute.", 502);
    }
    return checkEmailPage({ email, loginId: started.loginId });
  });

  app.post("/sign-in/code", async (c) => {
    const fields = await form(c);
    const loginId = fields.login ?? "";
    const limited = await hitAll(c.env.PLATFORM_DB, [[LIMITS.codePerIp, clientIp(c)]], c.get("now"));
    if (limited) return messagePage({ title: "Too many tries", body: tooMany(), status: 429, action: { href: "/sign-in", label: "Back to sign in" } });
    const result = await checkEmailCode(c.env.PLATFORM_DB, loginId, fields.code ?? "", c.get("now"));
    if (result.ok) return emailVerified(c, result.email, safeNext(result.nextPath));
    if (result.reason === "wrong_code") {
      const row = await c.env.PLATFORM_DB.prepare("SELECT email FROM email_logins WHERE id = ?").bind(loginId).first<{ email: string }>();
      return checkEmailPage({
        email: row?.email ?? "your address",
        loginId,
        status: 400,
        error: `That code isn't right. ${result.remaining === 1 ? "1 try left." : `${result.remaining} tries left.`}`,
      });
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
    const limited = await hitAll(c.env.PLATFORM_DB, [[LIMITS.linkPerIp, clientIp(c)]], c.get("now"));
    if (limited) return messagePage({ title: "Too many tries", body: tooMany(), status: 429 });
    const result = await consumeEmailLink(c.env.PLATFORM_DB, await formField(c, "token"), c.get("now"));
    if (!result) return linkExpired();
    return emailVerified(c, result.email, safeNext(result.nextPath));
  });

  // --- Passkeys ------------------------------------------------------------

  app.post("/sign-in/passkey/options", async (c) => {
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
    const limited = await hitAll(c.env.PLATFORM_DB, [[LIMITS.passkeyPerIp, clientIp(c)]], c.get("now"));
    if (limited) return c.json({ error: "rate_limited", message: tooMany() }, 429, NO_STORE);
    const ceremony = await takeCeremony(c.env.PLATFORM_DB, c.req.raw, "passkey_sign_in", c.get("now"));
    if (!ceremony) return c.json({ error: "expired", message: "That took too long. Please try again." }, 400, NO_STORE);
    const body = (await c.req.json().catch(() => ({}))) as { credential?: AuthenticationResponseJSON };
    let accountId: string;
    try {
      accountId = await verifyPasskeySignIn(c.env.PLATFORM_DB, {
        credential: body.credential as AuthenticationResponseJSON,
        challenge: ceremony.challenge,
        expect: passkeyExpectation(c),
        now: c.get("now"),
      });
    } catch (error) {
      if (!(error instanceof WebAuthnError) && !(error instanceof TypeError)) throw error;
      return withCookies(c.json({ error: "passkey_refused", message: "That passkey isn't on an OpenPing Hosted account. Try email instead." }, 400, NO_STORE), [clearCeremonyCookie()]);
    }
    const account = await getAccount(c.env.PLATFORM_DB, accountId);
    if (!account || account.disabledAt !== null) return c.json({ error: "disabled", message: "This account is closed." }, 403, NO_STORE);
    const session = await createSession(c.env.PLATFORM_DB, account.id, "passkey", c.get("now"));
    await audit(c.env.PLATFORM_DB, { accountId: account.id, actor: "customer", action: "account.signed_in", detail: { method: "passkey" }, now: c.get("now") });
    return withCookies(c.json({ ok: true, redirect: ceremony.nextPath ?? "/account" }, 200, NO_STORE), [session, clearCeremonyCookie()]);
  });

  app.post("/account/passkeys/options", async (c) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "signed_out", message: "Please sign in again." }, 401, NO_STORE);
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
    const ceremony = await takeCeremony(c.env.PLATFORM_DB, c.req.raw, "passkey_register", c.get("now"));
    if (!ceremony || ceremony.accountId !== session.account.id) {
      return c.json({ error: "expired", message: "That took too long. Please try again." }, 400, NO_STORE);
    }
    const body = (await c.req.json().catch(() => ({}))) as { credential?: RegistrationResponseJSON; name?: unknown };
    try {
      await addPasskey(c.env.PLATFORM_DB, {
        account: session.account,
        credential: body.credential as RegistrationResponseJSON,
        challenge: ceremony.challenge,
        expect: passkeyExpectation(c),
        label: passkeyLabel(body.name ?? c.req.header("sec-ch-ua-platform")?.replace(/"/g, "")),
        now: c.get("now"),
      });
    } catch (error) {
      if (!(error instanceof WebAuthnError) && !(error instanceof TypeError)) throw error;
      return withCookies(c.json({ error: "passkey_refused", message: "That passkey couldn't be added. Please try again." }, 400, NO_STORE), [clearCeremonyCookie()]);
    }
    await audit(c.env.PLATFORM_DB, { accountId: session.account.id, actor: "customer", action: "passkey.added", now: c.get("now") });
    return withCookies(c.json({ ok: true, redirect: "/account?done=passkey" }, 200, NO_STORE), [clearCeremonyCookie()]);
  });

  app.post("/account/passkeys/:id/delete", async (c) => {
    const session = c.get("session");
    if (!session) return seeOther(c, "/sign-in");
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
    const state = newOAuthState();
    const cookie = await startCeremony(c.env.PLATFORM_DB, {
      kind: "github",
      challenge: state,
      accountId: linking ? session!.account.id : null,
      nextPath: linking ? "/account" : nextFromQuery(c),
      now: c.get("now"),
    });
    return seeOther(c, authorizeUrl(config, { redirectUri: callbackUrl(c), state }), [cookie]);
  });

  app.get("/auth/github/callback", async (c) => {
    const config = githubConfig(c.env);
    const failed = (body: string, status = 400) =>
      withCookies(messagePage({ title: "GitHub sign-in didn't work", body, status, action: { href: "/sign-in", label: "Back to sign in" } }), [clearCeremonyCookie()]);
    if (!config) return failed("GitHub sign-in isn't available. Please sign in with email instead.", 404);
    const limited = await hitAll(c.env.PLATFORM_DB, [[LIMITS.githubPerIp, clientIp(c)]], c.get("now"));
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
      user = await fetchGithubUser(config, { code, redirectUri: callbackUrl(c) }, deps.fetch);
    } catch (error) {
      console.error("[github] sign-in failed", { error: error instanceof Error ? error.message : String(error) });
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
      const found = await accountForVerifiedEmail(db, user.email, t, signUpsOpen(c.env));
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
      if (found.created) await audit(db, { accountId: account.id, actor: "customer", action: "account.created", detail: { method: "github" }, now: t });
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
    // Email always remains, so this never locks anyone out.
    await c.env.PLATFORM_DB.prepare("DELETE FROM account_identities WHERE account_id = ? AND kind = 'github'").bind(session.account.id).run();
    await audit(c.env.PLATFORM_DB, { accountId: session.account.id, actor: "customer", action: "github.unlinked", now: c.get("now") });
    return seeOther(c, "/account?done=github-removed");
  });

  // --- The account, its OpenPing, and the hand-off -------------------------

  const FLASH: Record<string, { message: string; tone: "ok" | "error" }> = {
    passkey: { message: "Passkey added. You can sign in with it next time.", tone: "ok" },
    "passkey-removed": { message: "Passkey removed.", tone: "ok" },
    github: { message: "GitHub connected.", tone: "ok" },
    "github-removed": { message: "GitHub disconnected.", tone: "ok" },
    "github-taken": { message: "That GitHub account is already connected to another OpenPing Hosted account.", tone: "error" },
  };

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
          trialEndsAt: tenant.trialEndsAt,
        }
      : null;
    return accountPage({
      email: session.account.email,
      tenant: view,
      passkeys: await listPasskeys(db, session.account.id),
      github: github ? { login: github.label } : null,
      githubOn: githubConfig(c.env) !== null,
      flash: FLASH[c.req.query("done") ?? ""] ?? null,
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
    const limited = await hitAll(
      db,
      [
        [LIMITS.signUpPerIp, clientIp(c)],
        [LIMITS.signUpGlobal, "all"],
      ],
      c.get("now"),
    );
    if (limited) return startPage({ domain: c.env.HOSTED_DOMAIN, slug, error: tooMany(), status: 429 });
    const result = await requestTenant(db, { accountId: session.account.id, slug, now: c.get("now") });
    if (!result.ok) return startPage({ domain: c.env.HOSTED_DOMAIN, slug, error: SLUG_MESSAGES[result.reason], status: 400 });
    await audit(db, { accountId: session.account.id, tenantId: result.tenantId, actor: "customer", action: "tenant.requested", detail: { slug: result.slug }, now: c.get("now") });
    // Provisioning runs after the answer; if it can't start now, the cron sweep picks it up.
    const setup = deps.provisioning(c.env, c.executionCtx as ExecutionContext);
    if (setup.ok) {
      c.executionCtx.waitUntil(
        runProvisioning(setup.deps, result.tenantId, { force: true }).catch((error) => console.error("[provision] first run failed", error)),
      );
    } else {
      console.warn("[provision] off until these are set:", setup.missing.join(", "));
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
      console.error("[handoff] HANDOFF_SIGNING_KEY is not set");
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

  // The tenant's sign-out ends its own session, then sends the browser here (contract, section 7).
  const signOut = async (c: Ctx) => {
    const cookie = await endSession(c.env.PLATFORM_DB, c.req.raw);
    return withCookies(messagePage({ title: "You're signed out", body: "Sign in again whenever you need your OpenPing.", action: { href: "/sign-in", label: "Sign in" } }), [cookie]);
  };
  app.get("/sign-out", signOut);
  app.post("/sign-out", signOut);

  // Billing (B5) isn't built yet; the tenant already links here.
  for (const path of ["/billing", "/billing/upgrade"]) {
    app.get(path, (c) =>
      messagePage({
        title: "Paid plans open soon",
        body: "Hosted will be $24 a year, and $12 a year more for 1-minute checks. Your trial keeps running until you can upgrade.",
        action: { href: c.get("session") ? "/account" : "/sign-in", label: c.get("session") ? "Back to your account" : "Sign in" },
      }),
    );
  }

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
