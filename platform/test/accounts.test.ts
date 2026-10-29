import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  HANDOFF_PATH,
  generateHandoffKeyPair,
  importHandoffPublicKey,
  verifyHandoffToken,
  type PlatformCapability,
} from "../../src/shared/hosted-contract";
import { SoftAuthenticator } from "../../test/support/soft-authenticator";
import { safeNext, type AccountDeps } from "../src/account-routes";
import { createApp } from "../src/app";
import { StaticBundleSource, type TenantBundle } from "../src/bundle";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey } from "../src/keys";
import { LEGAL_DOCUMENTS, TERMS_VERSION } from "../src/legal/documents";
import { applyEmailChange } from "../src/auth/email-change";
import { FakeMailer } from "./fake-mailer";
import type { ProvisioningDeps } from "../src/provisioning";
import { FakeCloudflareApi } from "./fake-cloudflare";
import { FakeDispatcher } from "./fake-dispatcher";
import { fakeOpenPing } from "./fake-openping";

const DOMAIN = "openping.test";
const APP = `https://app.${DOMAIN}`;
let keys: { publicKey: string; privateKey: string };

// --- The world: mail, GitHub, provisioning, all in memory -------------------

class Outbox extends FakeMailer {
  last(): { code: string; link: string; to: string; subject: string } {
    const m = this.sent.at(-1)!;
    return { to: m.to, subject: m.subject, code: /Code: (\d{6})/.exec(m.text)![1]!, link: /(https:\/\/\S+sign-in\/link\?token=\S+)/.exec(m.text)![1]! };
  }
}

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

const BUNDLE: TenantBundle = {
  version: "0.10.1",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default {}", contentType: "application/javascript+module" }],
  assets: [],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: [],
  assetsConfig: {},
  vars: {},
  durableObjects: [],
  migrations: [],
  d1Migrations: [],
};

let outbox: Outbox;
let github: {
  user: { id: number; login: string };
  emails: { email: string; primary: boolean; verified: boolean }[];
  calls: string[];
  verifiers: string[];
};
let signUps = "open";
let provisionQueue: Queue<{ tenantId: string }> | undefined;

const api = new FakeCloudflareApi();
const dispatcher = new FakeDispatcher();
api.onScriptChange = (name, script) => {
  if (script) dispatcher.register(name, fakeOpenPing(script).worker);
  else dispatcher.remove(name);
};

function provisioningDeps(): ProvisioningDeps {
  return {
    db: env.PLATFORM_DB,
    api,
    bundles: new StaticBundleSource(BUNDLE),
    dispatcher,
    capability: () => noopPlatform,
    config: { hostedDomain: DOMAIN, namespace: "ns", platformKey: generateMasterKey(), handoffPublicKey: keys.publicKey },
  };
}

const githubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  github.calls.push(url);
  if (url === "https://github.com/login/oauth/access_token") {
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier?: string };
    github.verifiers.push(body.code_verifier ?? "");
    return Response.json(body.code === "good" && body.code_verifier ? { access_token: "gho_test" } : { error: "bad_verification_code" });
  }
  if (url === "https://api.github.com/user") return Response.json(github.user);
  if (url === "https://api.github.com/user/emails") return Response.json(github.emails);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const deps: AccountDeps = {
  mailer: () => outbox,
  provisioning: () => ({ ok: true, deps: provisioningDeps() }),
  fetch: githubFetch,
};

const app = createApp({ dispatcher: () => dispatcher, capability: () => noopPlatform, accounts: deps });

function platformEnv(): PlatformEnv {
  return {
    ...(env as unknown as PlatformEnv),
    SIGN_UPS: signUps,
    HANDOFF_SIGNING_KEY: keys.privateKey,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    PROVISION_QUEUE: provisionQueue,
  };
}

let ipSeq = 0;

/** One browser: its cookies, its IP, and a same-origin Origin on every post. */
class Browser {
  cookies = new Map<string, string>();
  constructor(readonly ip = `198.51.100.${++ipSeq}`) {}

  async fetch(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown; origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    let body = init.body;
    if (init.form) body = new URLSearchParams(init.form);
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const method = init.method ?? (body ? "POST" : "GET");
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? APP);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const ctx = createExecutionContext();
    const url = path.startsWith("http") ? path : `${APP}${path}`;
    const res = await app.fetch(new Request(url, { method, headers, body, redirect: "manual" }), platformEnv(), ctx);
    await waitOnExecutionContext(ctx);
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (!value || attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  /** Signs in with an email code; answers the response of the code post. */
  async signInWithCode(email: string, next?: string): Promise<Response> {
    const page = await this.fetch("/sign-in/email", { form: { email, ...(next ? { next } : {}) } });
    expect(page.status).toBe(200);
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())![1]!;
    return this.fetch("/sign-in/code", { form: { login: loginId, code: outbox.last().code } });
  }
}

/** The page as a reader sees its text: entities decoded. */
async function textOf(res: Response): Promise<string> {
  return (await res.text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

let emailSeq = 0;
const newEmail = () => `person${++emailSeq}@example.com`;

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.PLATFORM_DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  keys = await generateHandoffKeyPair();
});

beforeEach(async () => {
  outbox = new Outbox();
  signUps = "open";
  provisionQueue = undefined;
  await env.PLATFORM_DB.prepare("DELETE FROM rate_limits").run();
  github = { user: { id: 4242, login: "octo" }, emails: [{ email: "octo@example.com", primary: true, verified: true }], calls: [], verifiers: [] };
});

// --- Tests ------------------------------------------------------------------

describe("the home page", () => {
  it("offers the trial when sign-ups are open, and the waitlist when they aren't", async () => {
    expect(await (await new Browser().fetch("/")).text()).toContain("Start a 30-day free trial");
    signUps = "closed";
    const closed = await (await new Browser().fetch("/")).text();
    expect(closed).toContain("isn't open for sign-ups yet");
    expect(closed).not.toContain('href="/sign-up"');
  });
});

describe("signing up with email, through to the customer's OpenPing", () => {
  it("emails a code and a link, signs in from the link, provisions on the chosen address, and hands off", async () => {
    const browser = new Browser();
    const email = newEmail();
    const sent = await browser.fetch("/sign-in/email", { form: { email: ` ${email.toUpperCase()} `, mode: "sign-up" } });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("Check your email");
    const mail = outbox.last();
    expect(mail.to).toBe(email);
    expect(mail.subject).toBe(`${mail.code} is your OpenPing sign-in code`);
    expect(mail.link.startsWith(`${APP}/sign-in/link?token=`)).toBe(true);
    expect(outbox.sent[0]!.html).toContain(mail.code);

    // Opening the link only shows a button: a mail scanner fetching it signs nobody in.
    const linkPath = mail.link.slice(APP.length);
    const confirm = await new Browser().fetch(linkPath);
    expect(confirm.status).toBe(200);
    const token = /name="token" value="([^"]+)"/.exec(await confirm.text())![1]!;
    expect(await count("SELECT COUNT(*) AS n FROM platform_sessions")).toBe(0);

    const signedIn = await browser.fetch("/sign-in/link", { form: { token } });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/account");
    expect(browser.cookies.has("__Host-op_platform")).toBe(true);
    const cookie = signedIn.headers.getSetCookie().find((c) => c.startsWith("__Host-op_platform="))!;
    expect(cookie).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);

    // The link is single use.
    expect((await new Browser().fetch("/sign-in/link", { form: { token } })).status).toBe(400);

    // No OpenPing yet: the account page sends them to choose an address.
    const account = await browser.fetch("/account");
    expect(account.headers.get("location")).toBe("/start");
    const start = await browser.fetch("/start");
    expect(await start.text()).toContain(`.${DOMAIN}</span>`);

    expect((await browser.fetch("/start", { form: { slug: "admin" } })).status).toBe(400);
    const created = await browser.fetch("/start", { form: { slug: "Signup-Co" } });
    expect(created.status).toBe(303);
    const tenant = await env.PLATFORM_DB.prepare("SELECT id, provision_state, account_id FROM tenants WHERE slug = 'signup-co'").first<{ id: string; provision_state: string; account_id: string }>();
    // Provisioning ran after the answer, through the fakes, to ready.
    expect(tenant!.provision_state).toBe("ready");

    const page = await (await browser.fetch("/account")).text();
    expect(page).toContain(`signup-co.${DOMAIN}`);
    expect(page).toContain("Trial, 30 days left");
    expect(page).toContain('href="/open?tenant=signup-co"');

    // A second OpenPing isn't on offer.
    expect((await browser.fetch("/start", { form: { slug: "another-co" } })).headers.get("location")).toBe("/account");

    // The hand-off: a token the tenant's verifier accepts, for this tenant and account.
    const open = await browser.fetch("/open?tenant=signup-co");
    expect(open.status).toBe(303);
    expect(open.headers.get("referrer-policy")).toBe("no-referrer");
    expect(open.headers.get("cache-control")).toBe("no-store");
    const location = new URL(open.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`https://signup-co.${DOMAIN}${HANDOFF_PATH}`);
    const verified = await verifyHandoffToken(location.searchParams.get("t")!, await importHandoffPublicKey(keys.publicKey), {
      tenantId: tenant!.id,
      now: Date.now(),
    });
    expect(verified).toMatchObject({ ok: true, claims: { aud: tenant!.id, sub: tenant!.account_id, email, role: "customer" } });
    const actions = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE account_id = ? ORDER BY id").bind(tenant!.account_id).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual([
      "account.created",
      "account.signed_in",
      "tenant.requested",
      "tenant.provisioned",
      "handoff.issued",
    ]);
  });

  it("returns a signed-out visitor from their OpenPing to it after signing in", async () => {
    const email = newEmail();
    const owner = new Browser();
    await owner.signInWithCode(email);
    await owner.fetch("/start", { form: { slug: "returnco" } });

    const browser = new Browser();
    // The tenant's signIn URL: /sign-in?tenant=<slug>.
    const page = await (await browser.fetch("/sign-in?tenant=returnco")).text();
    expect(page).toContain('name="next" value="/open?tenant=returnco"');
    const res = await browser.signInWithCode(email, "/open?tenant=returnco");
    // A page that goes on to /open by GET: after a post, the CSP's form-action
    // would block /open's redirect to the tenant's origin.
    expect(res.status).toBe(200);
    const continued = await res.text();
    expect(continued).toContain('<meta http-equiv="refresh" content="0;url=/open?tenant=returnco">');
    expect(continued).toContain('href="/open?tenant=returnco" rel="noreferrer">Continue to returnco</a>');
    expect((await browser.fetch("/open?tenant=returnco")).headers.get("location")).toMatch(/^https:\/\/returnco\.openping\.test\/auth\/hosted\?t=v1\./);
    // Already signed in, the tenant's sign-in link goes straight through.
    expect((await browser.fetch("/sign-in?tenant=returnco")).headers.get("location")).toBe("/open?tenant=returnco");
  });

  it("refuses to hand off to someone else's OpenPing, and sends a signed-out visitor to sign in", async () => {
    const owner = new Browser();
    await owner.signInWithCode(newEmail());
    await owner.fetch("/start", { form: { slug: "ownedco" } });
    const other = new Browser();
    await other.signInWithCode(newEmail());
    expect((await other.fetch("/open?tenant=ownedco")).status).toBe(404);
    expect((await new Browser().fetch("/open?tenant=ownedco")).headers.get("location")).toBe("/sign-in?tenant=ownedco");
  });
});

describe("the email code", () => {
  it("allows five tries, says how many are left, and is single use", async () => {
    const browser = new Browser();
    const page = await browser.fetch("/sign-in/email", { form: { email: newEmail() } });
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())![1]!;
    const right = outbox.last().code;
    const wrong = right === "000000" ? "111111" : "000000";
    const first = await browser.fetch("/sign-in/code", { form: { login: loginId, code: wrong } });
    expect(first.status).toBe(400);
    expect(await first.text()).toContain("4 tries left.");
    // Spaces are fine, as people type them from the email.
    const ok = await browser.fetch("/sign-in/code", { form: { login: loginId, code: `${right.slice(0, 3)} ${right.slice(3)}` } });
    expect(ok.status).toBe(303);
    expect((await new Browser().fetch("/sign-in/code", { form: { login: loginId, code: right } })).status).toBe(400);
  });

  it("is spent after five wrong tries, even with the right code after", async () => {
    const browser = new Browser();
    const page = await browser.fetch("/sign-in/email", { form: { email: newEmail() } });
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())![1]!;
    const right = outbox.last().code;
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await browser.fetch("/sign-in/code", { form: { login: loginId, code: wrong } });
    const fifth = await browser.fetch("/sign-in/code", { form: { login: loginId, code: wrong } });
    expect(await fifth.text()).toContain("This code has expired");
    expect(await (await browser.fetch("/sign-in/code", { form: { login: loginId, code: right } })).text()).toContain("This code has expired");
  });

  it("refuses bad and throwaway addresses, and limits mail to one address", async () => {
    const browser = new Browser();
    expect(await (await browser.fetch("/sign-in/email", { form: { email: "not-an-email" } })).text()).toContain("Enter an email address");
    expect(await (await browser.fetch("/sign-in/email", { form: { email: "x@mailinator.com" } })).text()).toContain("permanent email");
    const email = newEmail();
    for (let i = 0; i < 5; i++) expect((await new Browser().fetch("/sign-in/email", { form: { email } })).status).toBe(200);
    expect((await new Browser().fetch("/sign-in/email", { form: { email } })).status).toBe(429);
    expect(outbox.sent.filter((m) => m.to === email)).toHaveLength(5);
  });

  it("says so when the email can't be sent", async () => {
    outbox.fail = "unavailable";
    const res = await new Browser().fetch("/sign-in/email", { form: { email: newEmail() } });
    expect(res.status).toBe(502);
    expect(await textOf(res)).toContain("couldn't send the email");
  });

  it("lets existing accounts in but makes no new ones while sign-ups are closed", async () => {
    const existing = newEmail();
    await new Browser().signInWithCode(existing);
    signUps = "closed";
    expect((await new Browser().signInWithCode(existing)).status).toBe(303);
    // A stranger sees the usual page, but no email goes out and no account is made.
    const sentBefore = outbox.sent.length;
    const stranger = newEmail();
    const page = await new Browser().fetch("/sign-in/email", { form: { email: stranger } });
    expect(await page.text()).toContain("Check your email");
    expect(outbox.sent).toHaveLength(sentBefore);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE email = ?", stranger)).toBe(0);
  });
});

describe("requests from other sites", () => {
  it("never change anything", async () => {
    const browser = new Browser();
    for (const origin of ["https://evil.example", `https://acme.${DOMAIN}`]) {
      const res = await browser.fetch("/sign-in/email", { form: { email: newEmail() }, origin });
      expect(res.status).toBe(403);
    }
    expect((await browser.fetch("/sign-in/email", { form: { email: newEmail() }, origin: null })).status).toBe(403);
    const crossSite = { "sec-fetch-site": "cross-site" };
    expect((await browser.fetch("/sign-in/email", { form: { email: newEmail() }, origin: "null", headers: crossSite })).status).toBe(403);
    expect(outbox.sent).toHaveLength(0);
  });

  it("accept the page's own posts when the browser sends Origin: null", async () => {
    const res = await new Browser().fetch("/sign-in/email", { form: { email: newEmail() }, origin: "null", headers: { "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });

  it("are told nothing by the pages' referrer", async () => {
    expect((await new Browser().fetch("/sign-in")).headers.get("referrer-policy")).toBe("same-origin");
  });

  it("can only send the browser on to the platform's own pages after sign-in", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/open?tenant=x/../../", "/account?x=1", "/\\evil", null, 7]) {
      expect(safeNext(bad), String(bad)).toBeNull();
    }
    expect(safeNext("/open?tenant=acme")).toBe("/open?tenant=acme");
  });
});

describe("passkeys", () => {
  it("can be added on the account page, used to sign in alone, and removed", async () => {
    const browser = new Browser();
    const email = newEmail();
    await browser.signInWithCode(email);
    const authenticator = await SoftAuthenticator.create();

    const options = (await (await browser.fetch("/account/passkeys/options", { json: {} })).json()) as any;
    expect(options.rp).toEqual({ id: `app.${DOMAIN}`, name: "OpenPing Hosted" });
    expect(options.user.name).toBe(email);
    expect(options.authenticatorSelection.residentKey).toBe("required");
    const credential = await authenticator.register(options, APP);
    const added = await browser.fetch("/account/passkeys", { json: { credential }, headers: { "sec-ch-ua-platform": '"Android"' } });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true, redirect: "/account?done=passkey" });
    const page = await (await browser.fetch("/account?done=passkey")).text();
    expect(page).toContain("Passkey added.");
    expect(page).toContain("<strong>Android</strong>");

    // A new browser signs in with nothing but the passkey.
    const fresh = new Browser();
    const signInOptions = (await (await fresh.fetch("/sign-in/passkey/options", { json: { next: "/account" } })).json()) as any;
    expect(signInOptions.rpId).toBe(`app.${DOMAIN}`);
    expect(signInOptions.allowCredentials).toBeUndefined();
    const assertion = await authenticator.authenticate(signInOptions, APP);
    const res = await fresh.fetch("/sign-in/passkey", { json: { credential: assertion } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: "/account" });
    expect(fresh.cookies.has("__Host-op_platform")).toBe(true);

    // The challenge is single use, and another origin's signature is refused.
    expect((await fresh.fetch("/sign-in/passkey", { json: { credential: assertion } })).status).toBe(400);
    const phished = new Browser();
    const o2 = (await (await phished.fetch("/sign-in/passkey/options", { json: {} })).json()) as any;
    const bad = await phished.fetch("/sign-in/passkey", { json: { credential: await authenticator.authenticate(o2, "https://app.evil.example") } });
    expect(bad.status).toBe(400);
    expect(phished.cookies.has("__Host-op_platform")).toBe(false);

    const id = /action="\/account\/passkeys\/([^/]+)\/delete"/.exec(page)![1]!;
    // The email-only browser can't remove it: with a passkey on the account, only a passkey sign-in changes sign-in methods.
    expect((await browser.fetch(`/account/passkeys/${id}/delete`, { method: "POST" })).headers.get("location")).toBe("/account?done=sign-in-again");
    expect((await fresh.fetch(`/account/passkeys/${id}/delete`, { method: "POST" })).headers.get("location")).toBe("/account?done=passkey-removed");
    const again = new Browser();
    const o3 = (await (await again.fetch("/sign-in/passkey/options", { json: {} })).json()) as any;
    expect((await again.fetch("/sign-in/passkey", { json: { credential: await authenticator.authenticate(o3, APP) } })).status).toBe(400);
  });

  it("can't be added without a session", async () => {
    expect((await new Browser().fetch("/account/passkeys/options", { json: {} })).status).toBe(401);
  });
});

describe("GitHub", () => {
  const challenges: string[] = [];
  async function viaGithub(browser: Browser, path = "/auth/github", code = "good"): Promise<Response> {
    const start = await browser.fetch(path);
    expect(start.status).toBe(303);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("gh-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${APP}/auth/github/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    challenges.push(to.searchParams.get("code_challenge")!);
    return browser.fetch(`/auth/github/callback?code=${code}&state=${to.searchParams.get("state")}`);
  }

  it("signs up with the verified primary email, then signs in by GitHub id", async () => {
    const browser = new Browser();
    const res = await viaGithub(browser);
    // PKCE: the verifier sent with the code is the one behind the challenge GitHub was given.
    const { codeChallenge } = await import("../src/auth/github");
    expect(await codeChallenge(github.verifiers.at(-1)!)).toBe(challenges.at(-1));
    expect(res.headers.get("location")).toBe("/account");
    const account = await env.PLATFORM_DB.prepare("SELECT id FROM accounts WHERE email = 'octo@example.com'").first<{ id: string }>();
    expect(await count("SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ? AND kind = 'github' AND subject = '4242'", account!.id)).toBe(1);
    // The email on GitHub changes; the account still follows the GitHub id.
    github.emails = [{ email: "new-octo@example.com", primary: true, verified: true }];
    await viaGithub(new Browser());
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE email LIKE '%octo@example.com'")).toBe(1);
  });

  it("refuses a callback whose state isn't this browser's, or a GitHub account without a verified email", async () => {
    const browser = new Browser();
    const start = await browser.fetch("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const other = new Browser();
    expect((await other.fetch(`/auth/github/callback?code=good&state=${state}`)).status).toBe(400);
    expect((await browser.fetch(`/auth/github/callback?code=good&state=wrong${state}`)).status).toBe(400);
    expect(github.calls).toHaveLength(0);

    github.user = { id: 99, login: "nomail" };
    github.emails = [{ email: "nomail@example.com", primary: true, verified: false }];
    const res = await viaGithub(new Browser());
    expect(await res.text()).toContain("no verified email");
    expect((await viaGithub(new Browser(), "/auth/github", "bad")).status).toBe(502);
  });

  it("won't make an account for a throwaway GitHub email", async () => {
    github.user = { id: 77, login: "throwaway" };
    github.emails = [{ email: "someone@mailinator.com", primary: true, verified: true }];
    const res = await viaGithub(new Browser());
    expect(await textOf(res)).toContain("Please use a permanent email address");
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE email = 'someone@mailinator.com'")).toBe(0);
  });

  it("connects to the signed-in account, and won't take one connected elsewhere", async () => {
    const browser = new Browser();
    await browser.signInWithCode(newEmail());
    github.user = { id: 5151, login: "linker" };
    expect((await viaGithub(browser, "/auth/github?link=1")).headers.get("location")).toBe("/account?done=github");
    expect(await (await browser.fetch("/account?done=github")).text()).toContain("@linker");

    const second = new Browser();
    await second.signInWithCode(newEmail());
    expect((await viaGithub(second, "/auth/github?link=1")).headers.get("location")).toBe("/account?done=github-taken");

    expect((await browser.fetch("/account/github/unlink", { method: "POST" })).headers.get("location")).toBe("/account?done=github-removed");
  });
});

describe("sessions", () => {
  it("end on sign-out, from the account page or the tenant's redirect", async () => {
    const browser = new Browser();
    await browser.signInWithCode(newEmail());
    // The tenant's redirect is a GET: it shows the button, and signs nobody out by itself.
    const page = await browser.fetch("/sign-out");
    expect(await textOf(page)).toContain("Sign out of OpenPing Hosted too");
    expect((await browser.fetch("/start")).status).toBe(200);
    const out = await browser.fetch("/sign-out", { method: "POST" });
    expect(await textOf(out)).toContain("You're signed out");
    expect(browser.cookies.has("__Host-op_platform")).toBe(false);
    expect((await browser.fetch("/account")).headers.get("location")).toBe("/sign-in?next=%2Faccount");
    expect(await textOf(await browser.fetch("/sign-out"))).toContain("You're signed out");
  });

  it("stop working when the owner disables the account", async () => {
    const browser = new Browser();
    const email = newEmail();
    await browser.signInWithCode(email);
    await env.PLATFORM_DB.prepare("UPDATE accounts SET disabled_at = 1 WHERE email = ?").bind(email).run();
    expect((await browser.fetch("/account")).status).toBe(303);
    expect((await new Browser().signInWithCode(email)).status).toBe(403);
  });
});

describe("review fixes", () => {
  const key = (scope: string) => count("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE ?", `${scope}:%`);

  it("never lets one IP's refused requests use up the global mail budget", async () => {
    const browser = new Browser();
    for (let i = 0; i < 25; i++) await browser.fetch("/sign-in/email", { form: { email: newEmail() } });
    expect(await key("signin-email:ip")).toBe(25);
    // Only the 20 the IP was allowed count against everyone's budget.
    expect(await key("signin-email:all")).toBe(20);
    expect((await new Browser().fetch("/sign-in/email", { form: { email: newEmail() } })).status).toBe(200);
  });

  // Five full provisionings and six sign-ins: can take more than the default 5 seconds on a busy machine.
  it("counts a sign-up against the IP only once the address is acceptable, and the global limit only when the IP may", { timeout: 20_000 }, async () => {
    const ip = "203.0.113.50";
    // A refused address never reaches the limits, however often it is tried.
    const refused = new Browser(ip);
    await refused.signInWithCode(newEmail());
    for (let i = 0; i < 8; i++) expect((await refused.fetch("/start", { form: { slug: "admin" } })).status).toBe(400);
    expect(await key("signup:ip")).toBe(0);
    for (let i = 0; i < 7; i++) {
      // The first five each make an OpenPing (one per account); the last two are refused by the IP's limit.
      const browser = i < 5 ? new Browser(ip) : refused;
      if (i < 5) await browser.signInWithCode(newEmail());
      await browser.fetch("/start", { form: { slug: `ipco-${i}` } });
    }
    expect(await key("signup:ip")).toBe(7);
    expect(await key("signup:all")).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM tenants WHERE slug LIKE 'ipco-%'")).toBe(5);
  });

  it("keys IPv6 limits by /64", async () => {
    const { ipSubject } = await import("../src/auth/rate-limit");
    expect(ipSubject("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipSubject("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipSubject("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipSubject("198.51.100.7")).toBe("198.51.100.7");
    expect(ipSubject(null)).toBe("unknown");
    for (let i = 0; i < 20; i++) await new Browser(`2001:db8:5:6::${(i + 1).toString(16)}`).fetch("/sign-in/email", { form: { email: newEmail() } });
    expect((await new Browser("2001:db8:5:6:ffff::9").fetch("/sign-in/email", { form: { email: newEmail() } })).status).toBe(429);
    expect((await new Browser("2001:db8:5:7::1").fetch("/sign-in/email", { form: { email: newEmail() } })).status).toBe(200);
  });

  it("caps wrong codes per address per day across sign-ins, then only the link works", async () => {
    const email = newEmail();
    const loginOf = async (b: Browser) => /name="login" value="([^"]+)"/.exec(await (await b.fetch("/sign-in/email", { form: { email } })).text())![1]!;
    const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");
    // Two sign-ins, five wrong codes each.
    for (let round = 0; round < 2; round++) {
      const b = new Browser();
      const login = await loginOf(b);
      const wrong = wrongFor(outbox.last().code);
      for (let i = 0; i < 5; i++) await b.fetch("/sign-in/code", { form: { login, code: wrong } });
    }
    const b = new Browser();
    const login = await loginOf(b);
    const { code, link } = outbox.last();
    const refused = await b.fetch("/sign-in/code", { form: { login, code } });
    expect(refused.status).toBe(429);
    expect(await textOf(refused)).toContain("The link in your latest email still works");
    const token = /name="token" value="([^"]+)"/.exec(await (await b.fetch(link.slice(APP.length))).text())![1]!;
    expect((await b.fetch("/sign-in/link", { form: { token } })).status).toBe(303);
  });

  it("cancels an address's older sign-ins when a new one is asked for", async () => {
    const email = newEmail();
    const b = new Browser();
    const first = /name="login" value="([^"]+)"/.exec(await (await b.fetch("/sign-in/email", { form: { email } })).text())![1]!;
    const firstCode = outbox.last().code;
    await b.fetch("/sign-in/email", { form: { email } });
    expect(await textOf(await b.fetch("/sign-in/code", { form: { login: first, code: firstCode } }))).toContain("This code has expired");
  });

  it("sends nothing to an unknown address while sign-ups are closed, and looks the same", async () => {
    signUps = "closed";
    const res = await new Browser().fetch("/sign-in/email", { form: { email: newEmail() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(outbox.sent).toHaveLength(0);
  });

  it("treats a double submit of the address as the same OpenPing, and never makes two", async () => {
    const browser = new Browser();
    await browser.signInWithCode(newEmail());
    expect((await browser.fetch("/start", { form: { slug: "doubleco" } })).headers.get("location")).toBe("/account");
    expect((await browser.fetch("/start", { form: { slug: "doubleco" } })).headers.get("location")).toBe("/account");

    const racer = new Browser();
    await racer.signInWithCode(newEmail());
    const results = await Promise.all([
      racer.fetch("/start", { form: { slug: "raceone" } }),
      racer.fetch("/start", { form: { slug: "racetwo" } }),
    ]);
    for (const r of results) expect(r.headers.get("location")).toBe("/account");
    const accountId = (await env.PLATFORM_DB.prepare("SELECT account_id AS a FROM tenants WHERE slug IN ('raceone', 'racetwo')").first<{ a: string }>())!.a;
    expect(await count("SELECT COUNT(*) AS n FROM tenants WHERE account_id = ?", accountId)).toBe(1);
  });

  it("queues provisioning when the queue is bound", async () => {
    const sent: unknown[] = [];
    provisionQueue = { send: async (body: unknown) => void sent.push(body) } as unknown as Queue<{ tenantId: string }>;
    const browser = new Browser();
    await browser.signInWithCode(newEmail());
    await browser.fetch("/start", { form: { slug: "queuedsignup" } });
    const id = (await env.PLATFORM_DB.prepare("SELECT id, provision_state FROM tenants WHERE slug = 'queuedsignup'").first<{ id: string; provision_state: string }>())!;
    expect(sent).toEqual([{ tenantId: id.id }]);
    expect(id.provision_state).toBe("requested");
  });

  it("shows a paused OpenPing plainly", async () => {
    const browser = new Browser();
    const email = newEmail();
    await browser.signInWithCode(email);
    await browser.fetch("/start", { form: { slug: "pausedco" } });
    await env.PLATFORM_DB.prepare("UPDATE tenants SET provision_state = 'db_created', provision_paused_at = 1 WHERE slug = 'pausedco'").run();
    const res = await browser.fetch("/account");
    const page = await textOf(res);
    expect(page).toContain("Setting up your OpenPing hit a problem");
    expect(page).not.toContain('http-equiv="refresh"');
  });

  it("ends the browser's earlier session when it signs in again", async () => {
    const browser = new Browser();
    const email = newEmail();
    await browser.signInWithCode(email);
    await browser.signInWithCode(email);
    expect(await count("SELECT COUNT(*) AS n FROM platform_sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = ?", email)).toBe(1);
  });

  it("limits passkey sign-in starts in their own bucket", async () => {
    const browser = new Browser();
    for (let i = 0; i < 60; i++) expect((await browser.fetch("/sign-in/passkey/options", { json: {} })).status).toBe(200);
    expect((await browser.fetch("/sign-in/passkey/options", { json: {} })).status).toBe(429);
    expect(await key("signin-passkey:ip")).toBe(0);
  });
});

describe("the pages", () => {
  it("run no inline script, and load only the passkey helper from this origin", async () => {
    const res = await new Browser().fetch("/sign-in");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await res.text();
    expect(html).toContain('<script src="/static/passkeys.js" defer></script>');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('type="email" inputmode="email" autocomplete="email webauthn"');
    const script = await new Browser().fetch("/static/passkeys.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const signUp = await new Browser().fetch("/sign-up");
    expect(signUp.headers.get("content-security-policy")).not.toContain("script-src");
    expect(await signUp.text()).not.toContain("<script");
  });

  it("send a signed-out visitor to sign in first, then back to billing", async () => {
    for (const path of ["/billing", "/billing/upgrade"]) {
      const res = await new Browser().fetch(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(path)}`);
    }
  });
});

describe("the Terms of Service and the Privacy Policy", () => {
  it("are served from docs/legal with their last-updated date, to anyone, signed in or not", async () => {
    for (const [path, title, doc] of [
      ["/terms", "Terms of Service", LEGAL_DOCUMENTS.terms],
      ["/privacy", "Privacy Policy", LEGAL_DOCUMENTS.privacy],
    ] as const) {
      const res = await new Browser().fetch(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).not.toContain("script-src");
      const html = await res.text();
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain(`<time datetime="${doc.updated}">`);
      expect(html).toContain(doc.html);
      expect(html).toContain(`<a href="#${doc.sections[0]!.id}">`);
      expect(html).not.toContain("<script");
    }
    const signedIn = new Browser();
    await signedIn.signInWithCode(newEmail());
    expect((await signedIn.fetch("/terms")).status).toBe(200);
  });

  it("are linked from the footer of every customer page, and the sign-up and sign-in pages say what continuing means", async () => {
    for (const path of ["/", "/sign-in", "/sign-up", "/terms"]) {
      const html = await (await new Browser().fetch(path)).text();
      expect(html, path).toContain('<nav class="legal-links" aria-label="Legal"><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a></nav>');
    }
    const signUp = await textOf(await new Browser().fetch("/sign-up"));
    expect(signUp).toContain('By continuing, you agree to the <a href="/terms">Terms of Service</a> and the <a href="/privacy">Privacy Policy</a>.');
    expect(await textOf(await new Browser().fetch("/sign-in"))).toContain("Signing in with a new email or GitHub account creates an account, and means you agree to");
    // Closed sign-ups make no accounts, so there is nothing to agree to.
    signUps = "closed";
    expect(await textOf(await new Browser().fetch("/sign-in"))).not.toContain("creates an account, and means you agree");
    expect(await textOf(await new Browser().fetch("/sign-up"))).not.toContain("By continuing");
  });

  it("are accepted, with their version and time, by an account made with email or GitHub, and only then", async () => {
    const email = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(email);
    const row = await env.PLATFORM_DB.prepare("SELECT id, created_at, terms_version, terms_accepted_at FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; created_at: number; terms_version: string; terms_accepted_at: number }>();
    expect(row).toMatchObject({ terms_version: TERMS_VERSION });
    expect(row!.terms_accepted_at).toBe(row!.created_at);
    const created = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE account_id = ? AND action = 'account.created'")
      .bind(row!.id)
      .first<{ detail: string }>();
    expect(JSON.parse(created!.detail)).toEqual({ method: "email", termsVersion: TERMS_VERSION });

    // Signing in again changes nothing about what was accepted.
    await env.PLATFORM_DB.prepare("UPDATE accounts SET terms_accepted_at = 1 WHERE id = ?").bind(row!.id).run();
    await new Browser().signInWithCode(email);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ? AND terms_accepted_at = 1", row!.id)).toBe(1);

    github = { ...github, user: { id: 777001, login: "termsfan" }, emails: [{ email: "termsfan@example.com", primary: true, verified: true }] };
    const gh = new Browser();
    const start = await gh.fetch("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect((await gh.fetch(`/auth/github/callback?code=good&state=${state}`)).status).toBe(303);
    expect(
      await count("SELECT COUNT(*) AS n FROM accounts WHERE email = 'termsfan@example.com' AND terms_version = ? AND terms_accepted_at IS NOT NULL", TERMS_VERSION),
    ).toBe(1);
  });
});

describe("changing the sign-in email", () => {
  const codeOf = (text: string) => /Code: (\d{6})/.exec(text)![1]!;
  const changeIdOf = async (res: Response) => /name="change" value="([^"]+)"/.exec(await res.text())![1]!;
  async function accountOf(email: string) {
    return env.PLATFORM_DB.prepare("SELECT id, email FROM accounts WHERE email = ?").bind(email).first<{ id: string; email: string }>();
  }

  it("asks the new address for a code, switches only with it, and tells the old address", async () => {
    const oldEmail = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(oldEmail);
    const other = new Browser();
    await other.signInWithCode(oldEmail);
    const accountId = (await accountOf(oldEmail))!.id;
    // (An account without an OpenPing yet is sent to /start; "done" shows the page itself.)
    expect(await (await browser.fetch("/account?done=none")).text()).toContain('href="/account/email"');
    expect(await (await browser.fetch("/account/email")).text()).toContain("Change your email");

    const target = newEmail();
    const sent = await browser.fetch("/account/email", { form: { email: ` ${target.toUpperCase()} ` } });
    expect(sent.status).toBe(200);
    const changeId = await changeIdOf(sent);
    const mail = outbox.sent.at(-1)!;
    expect(mail).toMatchObject({ to: target, category: "email_change" });
    expect(mail.subject).toMatch(/^\d{6} is your OpenPing email change code$/);
    // Nothing changes yet, and a wrong code says so.
    expect((await accountOf(oldEmail))!.id).toBe(accountId);
    const wrong = await browser.fetch("/account/email/confirm", { form: { change: changeId, code: codeOf(mail.text) === "000000" ? "111111" : "000000" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("4 tries left");
    // Another account can't use this account's code.
    const stranger = new Browser();
    await stranger.signInWithCode(newEmail());
    expect((await stranger.fetch("/account/email/confirm", { form: { change: changeId, code: codeOf(mail.text) } })).status).toBe(400);

    const done = await browser.fetch("/account/email/confirm", { form: { change: changeId, code: codeOf(mail.text) } });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/account?done=email");
    expect(await accountOf(oldEmail)).toBeNull();
    expect((await accountOf(target))!.id).toBe(accountId);
    expect(await count("SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ? AND kind = 'email' AND subject = ?", accountId, target)).toBe(1);
    const notice = outbox.sent.at(-1)!;
    expect(notice).toMatchObject({ to: oldEmail, category: "email_changed" });
    expect(notice.text).toContain(`was changed to ${target}`);
    const audited = await env.PLATFORM_DB.prepare("SELECT detail FROM audit_events WHERE account_id = ? AND action = 'account.email_changed'").bind(accountId).first<{ detail: string }>();
    expect(JSON.parse(audited!.detail)).toEqual({ from: oldEmail, to: target });
    // This browser stays signed in; the other one is signed out.
    expect(await (await browser.fetch("/account?done=email")).text()).toContain("Your email is changed.");
    expect((await other.fetch("/account")).headers.get("location")).toBe("/sign-in?next=%2Faccount");
    // The new address signs in to the same account.
    await new Browser().signInWithCode(target);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ? AND email = ?", accountId, target)).toBe(1);
  });

  it("works from the link too, which only shows a button until it is pressed", async () => {
    const browser = new Browser();
    const oldEmail = newEmail();
    await browser.signInWithCode(oldEmail);
    const target = newEmail();
    await browser.fetch("/account/email", { form: { email: target } });
    const link = /(https:\/\/\S+\/account\/email\/confirm\?token=\S+)/.exec(outbox.sent.at(-1)!.text)![1]!;
    const page = await browser.fetch(link.slice(APP.length));
    expect(await page.text()).toContain(target);
    expect(await accountOf(oldEmail)).not.toBeNull();
    // Signed out, the link sends you to sign in first and back.
    const signedOut = await new Browser().fetch(link.slice(APP.length));
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toMatch(/^\/sign-in\?next=%2Faccount%2Femail%2Fconfirm%3Ftoken%3D/);
    const token = new URL(link).searchParams.get("token")!;
    expect((await browser.fetch("/account/email/confirm", { form: { token } })).headers.get("location")).toBe("/account?done=email");
    expect(await accountOf(target)).not.toBeNull();
    expect((await browser.fetch("/account/email/confirm", { form: { token } })).status).toBe(400);
  });

  it("needs a fresh sign-in, a passkey one when the account has a passkey", async () => {
    const email = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(email);
    const { id } = (await accountOf(email))!;
    await env.PLATFORM_DB.prepare("UPDATE platform_sessions SET created_at = created_at - ? WHERE account_id = ?").bind(16 * 60_000, id).run();
    for (const res of [await browser.fetch("/account/email"), await browser.fetch("/account/email", { form: { email: newEmail() } })]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("/sign-in?next=%2Faccount%2Femail");
    }
    const fresh = new Browser();
    await fresh.signInWithCode(email);
    await env.PLATFORM_DB.prepare(
      "INSERT INTO account_identities (id, account_id, kind, subject, public_key, alg, created_at) VALUES ('idn_pk_change', ?, 'passkey', 'cred-change', 'pk', -7, 0)",
    )
      .bind(id)
      .run();
    expect(await textOf(await fresh.fetch("/account/email"))).toContain("with your passkey");
  });

  it("sends nothing to an address another account holds, and says the same", async () => {
    const taken = newEmail();
    await new Browser().signInWithCode(taken);
    const browser = new Browser();
    await browser.signInWithCode(newEmail());
    const before = outbox.sent.length;
    const res = await browser.fetch("/account/email", { form: { email: taken } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your new email");
    expect(outbox.sent.length).toBe(before);
    for (const [email, message] of [
      ["not-an-address", "Enter an email address"],
      ["someone@mailinator.com", "permanent email address"],
    ] as const) {
      expect(await textOf(await browser.fetch("/account/email", { form: { email } }))).toContain(message);
    }
  });

  it("changes nothing at all when the account's email moved on meanwhile (a doubled confirm)", async () => {
    const email = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(email);
    const other = new Browser();
    await other.signInWithCode(email);
    const { id } = (await accountOf(email))!;
    const result = await applyEmailChange(env.PLATFORM_DB, { accountId: id, oldEmail: "not-current@example.com", newEmail: newEmail(), keepSessionHash: "x", now: Date.now() });
    expect(result).toBe("stale");
    expect(await count("SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ? AND kind = 'email' AND subject = ?", id, email)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM platform_sessions WHERE account_id = ?", id)).toBe(2);
  });

  it("refuses an address that signed up meanwhile, and changes nothing", async () => {
    const oldEmail = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(oldEmail);
    const target = newEmail();
    const changeId = await changeIdOf(await browser.fetch("/account/email", { form: { email: target } }));
    const code = codeOf(outbox.sent.at(-1)!.text);
    await new Browser().signInWithCode(target);
    const res = await browser.fetch("/account/email/confirm", { form: { change: changeId, code } });
    expect(res.status).toBe(409);
    expect(await accountOf(oldEmail)).not.toBeNull();
  });
});

describe("a stale session", () => {
  it("can't add its own passkey and then pass the fresh sign-in checks with it", async () => {
    const email = newEmail();
    const browser = new Browser();
    await browser.signInWithCode(email);
    const { id } = (await env.PLATFORM_DB.prepare("SELECT id FROM accounts WHERE email = ?").bind(email).first<{ id: string }>())!;
    // Someone holding a 16-minute-old session (a borrowed laptop, a stolen cookie).
    await env.PLATFORM_DB.prepare("UPDATE platform_sessions SET created_at = created_at - ? WHERE account_id = ?").bind(16 * 60_000, id).run();
    const options = await browser.fetch("/account/passkeys/options", { json: {} });
    expect(options.status).toBe(401);
    expect(((await options.json()) as { error: string }).error).toBe("sign_in_again");
    expect((await browser.fetch("/account/passkeys", { json: { credential: {} } })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ? AND kind = 'passkey'", id)).toBe(0);
    // Nor link a GitHub account of its own, or unlink one.
    const link = await browser.fetch("/auth/github?link=1");
    expect(link.headers.get("location")).toBe("/account?done=sign-in-again");
    expect((await browser.fetch("/account/github/unlink", { method: "POST" })).headers.get("location")).toBe("/account?done=sign-in-again");
    // So the email change, and everything else behind a fresh sign-in, stays closed to it.
    expect((await browser.fetch("/account/email", { form: { email: newEmail() } })).status).toBe(401);
    expect(await accountEmailIs(id, email)).toBe(true);
  });
});

async function accountEmailIs(id: string, email: string): Promise<boolean> {
  return (await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ? AND email = ?", id, email)) === 1;
}
