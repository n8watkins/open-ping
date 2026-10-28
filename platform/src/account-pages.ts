/**
 * The pages of app.<domain>: home, sign-up and sign-in, the email code, the
 * address picker, the account page, and a few short messages. Phone first
 * (docs/MOBILE_PLAN.md): one column, full-width 48 px buttons, 16 px inputs
 * with the right keyboards.
 */

import { PASSKEY_SCRIPT_PATH } from "./client-script";
import type { Passkey } from "./auth/passkeys";
import { SLUG_MAX_LENGTH } from "./slugs";
import type { ProvisionState } from "./tenants";
import { GITHUB_ICON, Html, PASSKEY_ICON, SUPPORT_EMAIL, html, notice, renderPage } from "./ui";
import type { PlanId, TenantStatus } from "../../src/shared/hosted-contract";

export interface SignInPageInput {
  mode: "sign-in" | "sign-up";
  next: string | null;
  error?: string | null;
  email?: string;
  mailOn: boolean;
  githubOn: boolean;
  signUpsOpen: boolean;
  status?: number;
}

const withNext = (path: string, next: string | null) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

export function homePage(input: { signUpsOpen: boolean }): Response {
  return renderPage({
    title: "Uptime monitoring, run for you",
    main: html`<h1>Uptime monitoring and a status page, run for you</h1>
<p class="lead">20 monitors, 2 status pages and every alert channel for $24 a year. The same OpenPing as a self-hosted install, at your own address, with nothing to set up.${
  input.signUpsOpen ? " The 14-day trial needs no card." : ""
}</p>
${
  input.signUpsOpen
    ? html`<div class="stack"><a class="button primary" href="/sign-up">Start a 14-day free trial</a><a class="button secondary" href="/sign-in">Sign in</a></div>`
    : html`<p>OpenPing Hosted isn't open for sign-ups yet. <a href="https://openping.n8builds.dev/#pricing">Join the waitlist</a> to hear when it opens.</p>
<div class="stack"><a class="button secondary" href="/sign-in">Sign in</a></div>`
}`,
  });
}

export function signInPage(input: SignInPageInput): Response {
  const signUp = input.mode === "sign-up";
  const title = signUp ? "Start your free trial" : "Sign in to OpenPing Hosted";
  const closed = signUp && !input.signUpsOpen;
  const nextField = input.next ? html`<input type="hidden" name="next" value="${input.next}">` : "";
  const email = input.mailOn
    ? html`<form method="post" action="/sign-in/email" novalidate>
${nextField}<input type="hidden" name="mode" value="${input.mode}">
<div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="email webauthn" autocapitalize="off" spellcheck="false" required maxlength="254" placeholder="you@example.com" value="${input.email ?? ""}"${
        input.error ? new Html(' aria-describedby="form-error" aria-invalid="true"') : ""
      }>
<p class="hint">We'll email you a 6-digit code and a link.</p></div>
<button class="button primary" type="submit">${signUp ? "Continue with email" : "Email me a code"}</button>
</form>`
    : html`<p class="notice">Email sign-in isn't available right now. Use ${input.githubOn ? "GitHub or a passkey" : "a passkey"}, or try again later.</p>`;
  const others = html`<div class="stack">
${input.githubOn ? html`<a class="button secondary" href="${withNext("/auth/github", input.next)}">${GITHUB_ICON}Continue with GitHub</a>` : ""}
${
  signUp
    ? ""
    : html`<button class="button secondary" type="button" data-passkey="sign-in" data-next="${input.next ?? ""}" data-error="passkey-error" hidden>${PASSKEY_ICON}Sign in with a passkey</button>`
}
</div>
<p class="notice error" id="passkey-error" role="alert" hidden></p>`;
  const main = closed
    ? html`<h1>Sign-ups aren't open yet</h1>
<p>OpenPing Hosted is getting ready. <a href="https://openping.n8builds.dev/#pricing">Join the waitlist</a> and we'll email you when it opens.</p>
<p class="switch">Already have an account? <a href="${withNext("/sign-in", input.next)}">Sign in</a></p>`
    : html`<h1>${title}</h1>
${
  signUp
    ? html`<p class="lead">14 days free with 5 monitors and no card. Your OpenPing is ready about a minute after you sign up.</p>`
    : html`<p class="lead">Use the email, GitHub account or passkey you signed up with.</p>`
}
${input.error ? html`<p class="notice error" id="form-error" role="alert">${input.error}</p>` : ""}
${email}
${input.mailOn || input.githubOn || !signUp ? html`<div class="or">or</div>` : ""}
${others}
<p class="switch">${
        signUp
          ? html`Already have an account? <a href="${withNext("/sign-in", input.next)}">Sign in</a>`
          : html`New to OpenPing Hosted? <a href="${withNext("/sign-up", input.next)}">Start a free trial</a>`
      }</p>`;
  return renderPage({ title, main, status: input.status, scripts: signUp ? [] : [PASSKEY_SCRIPT_PATH] });
}

export function checkEmailPage(input: { email: string; loginId: string; error?: string | null; status?: number }): Response {
  return renderPage({
    title: "Check your email",
    status: input.status,
    main: html`<h1>Check your email</h1>
<p class="lead">We sent a 6-digit code and a sign-in link to <strong>${input.email}</strong>. They work for 15 minutes.</p>
${input.error ? html`<p class="notice error" id="code-error" role="alert">${input.error}</p>` : ""}
<form method="post" action="/sign-in/code" novalidate>
<input type="hidden" name="login" value="${input.loginId}">
<div class="field"><label for="code">Code</label>
<input class="code" id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required placeholder="000000" autofocus${
      input.error ? new Html(' aria-describedby="code-error" aria-invalid="true"') : ""
    }></div>
<button class="button primary" type="submit">Continue</button>
</form>
<p class="switch">Wrong address or no email after a minute? <a href="/sign-in">Start again</a></p>`,
  });
}

export function confirmLinkPage(token: string): Response {
  return renderPage({
    title: "Finish signing in",
    main: html`<h1>Finish signing in</h1>
<p class="lead">Continue to sign in to OpenPing Hosted on this device.</p>
<form method="post" action="/sign-in/link"><input type="hidden" name="token" value="${token}">
<button class="button primary" type="submit">Continue</button></form>`,
  });
}

export function messagePage(input: { title: string; body: string; status?: number; action?: { href: string; label: string } }): Response {
  return renderPage({
    title: input.title,
    status: input.status ?? 200,
    main: html`<h1>${input.title}</h1>
<p>${input.body}</p>
${input.action ? html`<div class="stack"><a class="button primary" href="${input.action.href}">${input.action.label}</a></div>` : ""}`,
  });
}

export function startPage(input: { domain: string; slug?: string; error?: string | null; previousFailed?: boolean; status?: number }): Response {
  return renderPage({
    title: "Choose your address",
    status: input.status,
    main: html`<h1>Choose your OpenPing's address</h1>
<p class="lead">Your dashboard and status page live here. Pick something short, like your company or project name.</p>
${input.previousFailed && !input.error ? notice("We couldn't finish setting up your last OpenPing, and nothing was kept. Please try again.", "info") : ""}
${input.error ? html`<p class="notice error" id="slug-error" role="alert">${input.error}</p>` : ""}
<form method="post" action="/start" novalidate>
<div class="field"><label for="slug">Address</label>
<div class="suffix"><input id="slug" name="slug" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" required minlength="3" maxlength="${SLUG_MAX_LENGTH}" placeholder="acme" value="${input.slug ?? ""}"${
      input.error ? new Html(' aria-describedby="slug-error" aria-invalid="true"') : ""
    }><span>.${input.domain}</span></div>
<p class="hint">Lowercase letters, digits and dashes, 3 to ${SLUG_MAX_LENGTH} characters.</p></div>
<button class="button primary" type="submit">Create my OpenPing</button>
</form>`,
  });
}

export interface AccountTenantView {
  slug: string;
  url: string;
  status: TenantStatus;
  plan: PlanId;
  provisionState: ProvisionState;
  slow: boolean;
  /** Provisioning stopped for the owner to look at. */
  paused: boolean;
  trialEndsAt: number | null;
}

const PLAN_NAMES: Record<PlanId, string> = { trial: "Free trial", hosted: "Hosted, yearly", hosted_fast: "Hosted with 1-minute checks" };

function daysLeft(until: number, now: number): string {
  const days = Math.max(0, Math.ceil((until - now) / 86_400_000));
  return days === 1 ? "1 day left" : `${days} days left`;
}

function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function dateTimeText(ms: number): string {
  const d = new Date(ms);
  return `${dateText(ms)}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

function tenantSection(tenant: AccountTenantView | null, now: number): Html {
  if (!tenant) {
    return html`<h2>Your OpenPing</h2><p>You don't have an OpenPing yet.</p>
<div class="stack"><a class="button primary" href="/start">Create my OpenPing</a></div>`;
  }
  if (tenant.provisionState !== "ready" && tenant.paused) {
    return html`<p class="badge" style="--tone: var(--degraded)">Needs a look</p>
<h2>Setting up your OpenPing hit a problem</h2>
<p class="address">${tenant.url.replace(/^https?:\/\//, "")}</p>
<p>Nothing is lost and the address stays yours. We've been told and will finish it; write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> if you'd like an update.</p>`;
  }
  if (tenant.provisionState !== "ready") {
    return html`<p class="badge" style="--tone: var(--degraded)">Setting up</p>
<h2>Your OpenPing is being set up</h2>
<p class="address">${tenant.url.replace(/^https?:\/\//, "")}</p>
<p>${tenant.slow ? "This is taking longer than usual. It keeps trying on its own; you can leave this page and come back." : "This usually takes less than a minute. This page refreshes on its own."}</p>`;
  }
  const badge =
    tenant.status === "suspended"
      ? html`<p class="badge" style="--tone: var(--suspended)">Paused</p>`
      : tenant.status === "past_due"
        ? html`<p class="badge" style="--tone: var(--degraded)">Payment due</p>`
        : tenant.status === "trial" && tenant.trialEndsAt
          ? html`<p class="badge">Trial, ${daysLeft(tenant.trialEndsAt, now)}</p>`
          : html`<p class="badge" style="--tone: var(--up)">Active</p>`;
  return html`${badge}
<h2>Your OpenPing</h2>
<p class="address">${tenant.url.replace(/^https?:\/\//, "")}</p>
<p>${PLAN_NAMES[tenant.plan]}${tenant.status === "trial" && tenant.trialEndsAt ? `, ends ${dateText(tenant.trialEndsAt)}` : ""}.</p>
${
  tenant.status === "suspended"
    ? html`<p>Its checks are paused and its status page is offline. Your monitors and history are kept for 30 days. Write to support to restore it.</p>`
    : html`<div class="stack"><a class="button primary" href="/open?tenant=${tenant.slug}">Open my OpenPing</a></div>`
}`;
}

export function accountPage(input: {
  email: string;
  tenant: AccountTenantView | null;
  passkeys: Passkey[];
  github: { login: string | null } | null;
  githubOn: boolean;
  flash?: { message: string; tone: "ok" | "error" } | null;
  /** Each time the OpenPing team signed in to this OpenPing to help, newest first (the admin console's support sign-in). */
  supportSignIns?: { at: number; reason: string | null }[];
  /** The platform's owner: link the admin console. */
  isOwner?: boolean;
  now: number;
}): Response {
  const settingUp = input.tenant !== null && input.tenant.provisionState !== "ready" && !input.tenant.paused;
  const passkeys = input.passkeys.length
    ? html`<ul class="rows">${input.passkeys.map(
        (p) => html`<li><div class="what"><strong>${p.label ?? "Passkey"}</strong><span>Added ${dateText(p.createdAt)}${
          p.lastUsedAt ? `, last used ${dateText(p.lastUsedAt)}` : ""
        }</span></div>
<form method="post" action="/account/passkeys/${p.id}/delete"><button class="button danger small" type="submit" aria-label="Remove ${p.label ?? "passkey"}">Remove</button></form></li>`,
      )}</ul>`
    : html`<p>Sign in with your fingerprint, face or device PIN instead of a code.</p>`;
  const github = input.github
    ? html`<ul class="rows"><li><div class="what"><strong>GitHub</strong><span>${input.github.login ? `@${input.github.login}` : "Connected"}</span></div>
<form method="post" action="/account/github/unlink"><button class="button danger small" type="submit">Disconnect</button></form></li></ul>`
    : input.githubOn
      ? html`<div class="stack"><a class="button secondary" href="/auth/github?link=1">${GITHUB_ICON}Connect GitHub</a></div>`
      : "";
  return renderPage({
    title: "Your account",
    wide: true,
    homeHref: "/account",
    refreshSeconds: settingUp ? 3 : undefined,
    scripts: [PASSKEY_SCRIPT_PATH],
    main: html`<h1>Your account</h1>
<p class="lead">Signed in as<strong class="email">${input.email}</strong></p>
${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
<section>${tenantSection(input.tenant, input.now)}</section>
<section><h2>Passkeys</h2>
${passkeys}
<div class="stack" id="add-passkey" hidden><button class="button secondary" type="button" data-passkey="add" data-error="passkey-error" data-reveal="add-passkey" hidden>${PASSKEY_ICON}Add a passkey</button></div>
<p class="notice error" id="passkey-error" role="alert" hidden></p>
</section>
<section><h2>Sign-in methods</h2>
<ul class="rows"><li><div class="what"><strong>Email</strong><span>${input.email}</span></div></li></ul>
${github}
</section>
${
  input.supportSignIns?.length
    ? html`<section><h2>Support access</h2>
<p>Each time the OpenPing team signed in to your OpenPing to help, and why. A support sign-in lasts at most an hour.</p>
<ul class="rows">${input.supportSignIns.map(
        (s) => html`<li><div class="what"><strong>${s.reason ?? "Support sign-in"}</strong><span>${dateTimeText(s.at)}</span></div></li>`,
      )}</ul></section>`
    : ""
}
<section><h2>Billing</h2><p>Paid plans open soon: $24 a year, and $12 a year more for 1-minute checks. Your trial keeps running until then.</p></section>
${input.isOwner ? html`<section><h2>Owner</h2><div class="stack"><a class="button secondary" href="/admin">Open the admin console</a></div></section>` : ""}
<section><form method="post" action="/sign-out"><button class="button secondary" type="submit">Sign out</button></form></section>`,
  });
}

/** The GET of /sign-out: the tenant's sign-out lands here, and one tap ends the platform session too. */
export function signOutPage(): Response {
  return renderPage({
    title: "Sign out",
    main: html`<h1>You're signed out of your OpenPing</h1>
<p class="lead">You're still signed in to your OpenPing Hosted account on this device.</p>
<form method="post" action="/sign-out"><button class="button primary" type="submit">Sign out of OpenPing Hosted too</button></form>
<p class="switch"><a href="/account">Stay signed in</a></p>`,
  });
}
