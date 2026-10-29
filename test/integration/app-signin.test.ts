import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

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
const APP_UA = "Mozilla/5.0 (Linux; Android 14) Chrome/131.0.0.0 Mobile Safari/537.36 OpenPingApp/1.0.0 (Android)";

const target = { ...env, ADMIN_EMAIL: ADMIN } as Env;

class Browser {
  cookies = new Map<string, string>();
  constructor(
    readonly ip: string,
    readonly userAgent = "Mozilla/5.0 (Linux; Android 14) Chrome/131.0.0.0 Mobile Safari/537.36",
  ) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
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

  it("says it speaks the app sign-in", async () => {
    const status = await (await new Browser(nextIp()).fetch("/api/auth/status")).json<{ appSignIn?: number }>();
    expect(status.appSignIn).toBe(1);
  });

  it("signs a browser in, hands the session to the app, and leaves the browser signed out", async () => {
    const tab = new Browser(nextIp());
    const { verifier, state } = pkce();
    const start = await tab.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("/login?app=1");

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

    // The code worked once.
    const again = await exchange(new Browser(nextIp(), APP_UA), link.searchParams.get("code")!, verifier);
    expect(again.headers.get("location")).toBe("/login?error=app_signin_failed");
  });

  it("goes straight to the finish page when the browser is already signed in, and keeps that session", async () => {
    const tab = new Browser(nextIp());
    expect((await signInByEmailLink(tab)).headers.get("location")).toBe(`${ORIGIN}/`);
    const { verifier, state } = pkce();
    const start = await tab.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`);
    expect(start.headers.get("location")).toBe("/auth/app/finish");
    const link = appLink(await (await tab.fetch("/auth/app/finish")).text());
    expect((await tab.me()).authenticated).toBe(true);

    const app = new Browser(nextIp(), APP_UA);
    await exchange(app, link.searchParams.get("code")!, verifier);
    expect((await app.me()).authenticated).toBe(true);
  });

  it("refuses a code without the app's verifier", async () => {
    const tab = new Browser(nextIp());
    await signInByEmailLink(tab);
    const { verifier, state } = pkce();
    await tab.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`);
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
    const { verifier, state } = pkce();
    await tab.fetch(`/auth/app/start?challenge=${await s256(verifier)}&state=${state}`);
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
