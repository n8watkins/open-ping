import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { sha256hex } from "../../src/worker/lib/ids";
import { s256 } from "../../src/worker/routes/app-signin";
import { APP_REDIRECT_URI } from "../../src/shared/native-app";

/**
 * The Android app's sign-in through the browser (routes/app-signin.ts), end
 * to end through the real Worker and D1: a Custom Tab "browser" starts it and
 * signs in, the app's web view (a second cookie jar) redeems the code.
 */

const ORIGIN = "https://openping.test";
const ADMIN = "admin@openping.test";
const APP_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36 OpenPingApp/1.0.0 (Android)";

const target = { ...env, ADMIN_EMAIL: ADMIN, RESEND_API_KEY: "re_test" } as Env;

/** The emails sent through (a fake) Resend. */
let sentMail: Array<{ to: string | string[]; subject: string; text?: string }> = [];

class Browser {
  cookies = new Map<string, string>();
  constructor(
    readonly ip: string,
    readonly userAgent = "Mozilla/5.0 (Linux; Android 14) Chrome/131.0.0.0 Mobile Safari/537.36",
  ) {}

  async fetch(path: string, init: RequestInit & { fetchSite?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.fetchSite) headers.set("sec-fetch-site", init.fetchSite);
    headers.set("cf-connecting-ip", this.ip);
    headers.set("user-agent", this.userAgent);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await worker.fetch(
      new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body, redirect: "manual" }),
      target,
      createExecutionContext(),
    );
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (!value || expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  async me(): Promise<{ authenticated: boolean; identity?: string; identityKind?: string }> {
    return (await this.fetch("/api/auth/me")).json();
  }
}

/** Sign `browser` in with an email link, the way the admin's inbox would. */
async function signInByEmailLink(browser: Browser): Promise<Response> {
  const token = `link-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, 'magic_link', ?, ?, ?)`,
  )
    .bind(await sha256hex(token), JSON.stringify({ email: ADMIN }), now, now + 60_000)
    .run();
  return browser.fetch(`/auth/magic/verify?token=${encodeURIComponent(token)}`);
}

function pkce() {
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const state = crypto.randomUUID().replace(/-/g, "");
  return { verifier, state };
}

/** The "Open the OpenPing app" link on the finish page. */
function appLink(html: string): URL {
  const href = /<a class="button" href="([^"]+)"/.exec(html)?.[1];
  expect(href).toBeTruthy();
  return new URL(href!.replace(/&amp;/g, "&"));
}

async function exchange(app: Browser, code: string, verifier: string): Promise<Response> {
  return app.fetch("/auth/app/exchange", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, verifier }).toString(),
  });
}

let ip = 10;
const nextIp = () => `198.51.100.${ip++}`;

describe("signing in to the Android app through the browser", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(() => {
    sentMail = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.resend.com/emails") throw new Error(`network_error: ${url}`);
      sentMail.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_1" });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Start an app sign-in in `tab` the way the app does (a Custom Tab: Sec-Fetch-Site none). */
  async function start(tab: Browser) {
    const { verifier, state } = pkce();
    const res = await tab.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`, { fetchSite: "none" });
    return { res, verifier, state };
  }

  it("says it speaks the app sign-in", async () => {
    const status = await (await new Browser(nextIp()).fetch("/api/auth/status")).json<{ appSignIn?: number }>();
    expect(status.appSignIn).toBe(1);
  });

  it("signs a browser in, hands the session to the app, and leaves the browser signed out", async () => {
    const tab = new Browser(nextIp());
    const { res: started, verifier, state } = await start(tab);
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe("/login?app=1");
    expect(started.headers.getSetCookie().join()).toMatch(/^__Host-op_app_signin=[^;]+; Max-Age=900; Path=\/; HttpOnly; Secure; SameSite=Lax/);

    // Any sign-in ends at the app's finish page instead of the dashboard.
    const signedIn = await signInByEmailLink(tab);
    expect(signedIn.headers.get("location")).toBe(`${ORIGIN}/auth/app/finish`);

    const finish = await tab.fetch("/auth/app/finish");
    expect(finish.status).toBe(200);
    expect(finish.headers.get("cache-control")).toBe("no-store");
    const html = await finish.text();
    expect(html).toContain("Open the OpenPing app");
    const link = appLink(html);
    expect(`${link.protocol}${link.pathname}`).toBe(APP_REDIRECT_URI);
    expect(link.searchParams.get("state")).toBe(state);
    expect(link.searchParams.get("origin")).toBe(ORIGIN);

    // The browser was signed in only for the app, so that session is over.
    expect((await tab.me()).authenticated).toBe(false);

    const app = new Browser(nextIp(), APP_UA);
    const done = await exchange(app, link.searchParams.get("code")!, verifier);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/");
    expect(await app.me()).toMatchObject({ authenticated: true, identity: ADMIN, identityKind: "email" });

    // The admin hears about it, and sees the app's session in Settings.
    expect(sentMail).toEqual([
      expect.objectContaining({ to: ADMIN, subject: "The OpenPing app signed in", text: expect.stringContaining("Pixel 8") }),
    ]);
    const { sessions } = await (await app.fetch("/api/auth/sessions")).json<{
      sessions: Array<{ id: string; via: string | null; current: boolean; userAgent: string }>;
    }>();
    const mine = sessions.find((x) => x.current)!;
    expect(mine).toMatchObject({ via: "app", userAgent: APP_UA });
    expect(JSON.stringify(sessions)).not.toContain("csrf");

    // The code worked once.
    const again = await exchange(new Browser(nextIp(), APP_UA), link.searchParams.get("code")!, verifier);
    expect(again.headers.get("location")).toBe("/login?error=app_signin_failed");
  });

  it("asks a browser that is already signed in to sign in again, and keeps its session", async () => {
    const tab = new Browser(nextIp());
    expect((await signInByEmailLink(tab)).headers.get("location")).toBe(`${ORIGIN}/`);
    const { res: started, verifier } = await start(tab);
    // Never straight to the code: an old session isn't a fresh sign-in.
    expect(started.headers.get("location")).toBe("/login?app=1");
    const early = await tab.fetch("/auth/app/finish");
    expect(early.status).toBe(403);
    expect(await early.text()).not.toContain("signed-in?code");

    const again = await start(tab);
    await signInByEmailLink(tab);
    const link = appLink(await (await tab.fetch("/auth/app/finish")).text());
    expect((await tab.me()).authenticated).toBe(true);
    expect(again.verifier).not.toBe(verifier);
    const verifierForThisLink = again.verifier;

    const app = new Browser(nextIp(), APP_UA);
    await exchange(app, link.searchParams.get("code")!, verifierForThisLink);
    expect((await app.me()).authenticated).toBe(true);
  });

  it("can't be started by a web page, so a link someone sends you can't mint a code for their app", async () => {
    const victim = new Browser(nextIp());
    await signInByEmailLink(victim);
    for (const fetchSite of ["cross-site", "same-site", "same-origin"]) {
      const { verifier, state } = pkce();
      const res = await victim.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`, { fetchSite });
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie().join()).not.toContain("op_app_signin");
    }
    expect((await victim.fetch("/auth/app/finish")).status).toBe(400);
  });

  it("ignores a pending sign-in cookie it didn't set (no __Host- prefix): the next sign-in goes to the dashboard", async () => {
    // What a sibling subdomain could plant: a valid row, under the old name.
    const attacker = new Browser(nextIp());
    await start(attacker);
    const nonce = attacker.cookies.get("__Host-op_app_signin")!;
    const victim = new Browser(nextIp());
    victim.cookies.set("op_app_signin", nonce);
    expect((await signInByEmailLink(victim)).headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("refuses an exchange posted by another site's form (login CSRF), but takes the app's", async () => {
    const tab = new Browser(nextIp());
    const { verifier } = await start(tab);
    await signInByEmailLink(tab);
    const code = appLink(await (await tab.fetch("/auth/app/finish")).text()).searchParams.get("code")!;
    const body = new URLSearchParams({ code, verifier }).toString();
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const victim = new Browser(nextIp());
    for (const headers of [
      { ...form, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { ...form, origin: "https://evil.example" },
      { ...form, "sec-fetch-site": "same-site" },
    ]) {
      const res = await victim.fetch("/auth/app/exchange", { method: "POST", headers, body });
      expect(res.headers.get("location")).toBe("/login?error=app_signin_failed");
      expect((await victim.me()).authenticated).toBe(false);
    }
    // The app's web view: WebView.postUrl sends Origin: null and Sec-Fetch-Site: none.
    const app = new Browser(nextIp(), APP_UA);
    const ok = await app.fetch("/auth/app/exchange", {
      method: "POST",
      headers: { ...form, origin: "null", "sec-fetch-site": "none" },
      body,
    });
    expect(ok.headers.get("location")).toBe("/");
    expect((await app.me()).authenticated).toBe(true);
  });

  it("lets Settings sign the app's session out", async () => {
    const tab = new Browser(nextIp());
    const { verifier } = await start(tab);
    await signInByEmailLink(tab);
    const code = appLink(await (await tab.fetch("/auth/app/finish")).text()).searchParams.get("code")!;
    const app = new Browser(nextIp(), APP_UA);
    await exchange(app, code, verifier);

    const admin = new Browser(nextIp());
    await signInByEmailLink(admin);
    const csrf = (await (await admin.fetch("/api/auth/me")).json<{ csrf: string }>()).csrf;
    const { sessions } = await (await admin.fetch("/api/auth/sessions")).json<{ sessions: Array<{ id: string; via: string | null; current: boolean }> }>();
    const appSession = sessions.find((x) => x.via === "app" && !x.current)!;
    const appMe = await app.fetch("/api/auth/me");
    expect((await appMe.json<{ authenticated: boolean }>()).authenticated).toBe(true);

    const res = await admin.fetch(`/api/auth/sessions/${appSession.id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
    expect(res.status).toBe(200);
    expect((await app.me()).authenticated).toBe(false);
    expect((await admin.me()).authenticated).toBe(true);
    // Without the CSRF token, nothing happens.
    const own = sessions.find((x) => x.current)!;
    expect((await admin.fetch(`/api/auth/sessions/${own.id}`, { method: "DELETE" })).status).toBe(403);
  });

  it("refuses a code without the app's verifier", async () => {
    const tab = new Browser(nextIp());
    const { verifier } = await start(tab);
    await signInByEmailLink(tab);
    const link = appLink(await (await tab.fetch("/auth/app/finish")).text());

    // Another app that caught the link has the code, but not the verifier.
    const thief = new Browser(nextIp(), APP_UA);
    const stolen = await exchange(thief, link.searchParams.get("code")!, pkce().verifier);
    expect(stolen.headers.get("location")).toBe("/login?error=app_signin_failed");
    expect((await thief.me()).authenticated).toBe(false);

    // And the try used the code up: the real app has to start again.
    const app = new Browser(nextIp(), APP_UA);
    await exchange(app, link.searchParams.get("code")!, verifier);
    expect((await app.me()).authenticated).toBe(false);
  });

  it("checks what it is given", async () => {
    const tab = new Browser(nextIp());
    const bad = await tab.fetch("/auth/app/start?challenge=short&state=x");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const plain = await tab.fetch(
      `/auth/app/start?challenge=${await s256(pkce().verifier)}&state=${pkce().state}&challenge_method=plain`,
    );
    expect(plain.status).toBe(400);

    // The finish page with no sign-in started is only a dead end.
    const nothing = await new Browser(nextIp()).fetch("/auth/app/finish");
    expect(nothing.status).toBe(400);
    expect(await nothing.text()).not.toContain("signed-in?code");

    const malformed = await exchange(new Browser(nextIp(), APP_UA), "not-a-code", "short");
    expect(malformed.headers.get("location")).toBe("/login?error=app_signin_failed");
  });

  it("won't finish for a browser that never signed in", async () => {
    const tab = new Browser(nextIp());
    await start(tab);
    const finish = await tab.fetch("/auth/app/finish");
    expect(finish.status).toBe(403);
    expect(await finish.text()).not.toContain("signed-in?code");
  });

  it("serves assetlinks.json only when ANDROID_APP_LINKS is set", async () => {
    const off = await worker.fetch(new Request(`${ORIGIN}/.well-known/assetlinks.json`), target, createExecutionContext());
    expect(off.status).toBe(404);

    const fingerprint = "AB".repeat(32);
    const on = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/assetlinks.json`),
      { ...target, ANDROID_APP_LINKS: fingerprint } as Env,
      createExecutionContext(),
    );
    expect(on.status).toBe(200);
    const body = await on.json<Array<{ relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }>>();
    expect(body).toHaveLength(1);
    expect(body[0]!.relation).toContain("delegate_permission/common.get_login_creds");
    expect(body[0]!.target.package_name).toBe("dev.n8builds.openping");
    expect(body[0]!.target.sha256_cert_fingerprints).toEqual([fingerprint.match(/../g)!.join(":")]);
  });
});
