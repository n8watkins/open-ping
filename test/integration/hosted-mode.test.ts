import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { expiredAuthCleanupStatements } from "../../src/worker/lib/sessions";
import {
  HANDOFF_NONCE_RETENTION_SECONDS,
  PLAN_LIMITS,
  generateHandoffKeyPair,
  handoffClaims,
  importHandoffPrivateKey,
  signHandoffToken,
  type HandoffClaims,
  type HostedAuditEvent,
  type TenantProps,
} from "../../src/shared/hosted-contract";
import { SoftAuthenticator } from "../support/soft-authenticator";

/**
 * Hosted mode (docs/hosted/CONTRACT.md) through the real Worker and D1: a
 * plain install unchanged, the platform-managed paths refused, and the sign-in
 * hand-off. Props reach the Worker the way the dispatch namespace passes them,
 * as the ExecutionContext's `props`; there is no other way in.
 */

const ORIGIN = "https://openping.test";
const TENANT = "abcdefgh12345678";
const OTHER_TENANT = "zzzzzzzzzzzzzzzz";
const EMAIL = "owner@customer.test";
const SHELL = "<!doctype html><title>OpenPing</title>";

const URLS = {
  account: "https://app.hosted.test/account",
  billing: "https://app.hosted.test/billing",
  upgrade: "https://app.hosted.test/billing/upgrade",
  signIn: "https://app.hosted.test/sign-in",
  signOut: "https://app.hosted.test/sign-out",
};

/** The SPA shell, so client routes answer as they do in production. */
const ASSETS = {
  fetch: async () => new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } }),
} as unknown as Fetcher;

let keys: { publicKey: string; privateKey: string };
let signingKey: CryptoKey;
let audits: HostedAuditEvent[] = [];
let auditFails = false;

const plainEnv = (): Env => ({ ...env, ASSETS }) as Env;
const hostedEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, ASSETS, HOSTED_MODE: "1", TENANT_ID: TENANT, HANDOFF_PUBLIC_KEY: keys.publicKey, ...over }) as Env;

function tenantProps(over: Partial<TenantProps> = {}): TenantProps {
  return {
    contract: 1,
    invocation: "public",
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "trial",
      plan: "trial",
      limits: PLAN_LIMITS.trial,
      trialEndsAt: Date.now() + 14 * 86_400_000,
      urls: URLS,
    },
    platform: {
      sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
      reportUsage: async () => {},
      audit: async (event) => {
        if (auditFails) throw new Error("platform unavailable");
        audits.push(event);
      },
    },
    ...over,
  };
}

/** An ExecutionContext carrying props, as env.TENANTS.get(name, { props }) delivers them. */
function contextWith(props: unknown): ExecutionContext {
  const base = createExecutionContext();
  return {
    waitUntil: (p: Promise<unknown>) => base.waitUntil(p),
    passThroughOnException: () => base.passThroughOnException(),
    props,
  } as unknown as ExecutionContext;
}

type FetchInit = RequestInit & { json?: unknown; target?: Env; props?: unknown };

/** One simulated browser with its own cookies and IP. */
class Browser {
  cookies = new Map<string, string>();
  constructor(
    readonly ip: string,
    readonly defaults: { target: Env; props?: () => unknown },
  ) {}

  async fetch(path: string, init: FetchInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const props = "props" in init ? init.props : this.defaults.props?.();
    const res = await worker.fetch(
      new Request(`${ORIGIN}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }),
      init.target ?? this.defaults.target,
      contextWith(props),
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

  async me() {
    return (await this.fetch("/api/auth/me")).json<{
      authenticated: boolean;
      identity?: string;
      identityKind?: string;
      csrf?: string;
      expiresAt?: number;
      hosted?: Record<string, unknown>;
    }>();
  }
}

let ipCounter = 0;
const plainBrowser = () => new Browser(`198.51.100.${++ipCounter}`, { target: plainEnv() });
const hostedBrowser = () => new Browser(`203.0.113.${++ipCounter}`, { target: hostedEnv(), props: () => tenantProps() });

async function token(over: Partial<HandoffClaims> = {}, key: CryptoKey = signingKey, now = Date.now()): Promise<string> {
  return signHandoffToken({ ...handoffClaims({ tenantId: TENANT, accountId: "acct_1", email: EMAIL, now }), ...over }, key);
}

const handoffPath = (t: string) => `/auth/hosted?t=${encodeURIComponent(t)}`;

async function nonceCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM used_handoff_nonces").first<{ n: number }>())!.n;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keys = await generateHandoffKeyPair();
  signingKey = await importHandoffPrivateKey(keys.privateKey);
});

beforeEach(() => {
  audits = [];
  auditFails = false;
});

describe("a plain install (HOSTED_MODE unset)", () => {
  it("reports the same sign-in status as before, with nothing hosted in it", async () => {
    const status = await (await plainBrowser().fetch("/api/auth/status")).json<Record<string, unknown>>();
    expect(Object.keys(status).sort()).toEqual(
      [
        "setupComplete",
        "encryptionConfigured",
        "githubEnabled",
        "githubAdminConfigured",
        "emailAdminConfigured",
        "passkeyConfigured",
        "passkeyRpId",
        "passkeyOrigin",
        "homePage",
        "waitlistEnabled",
      ].sort(),
    );
    expect(status.setupComplete).toBe(false);
  });

  it("ignores props even when a caller passes them", async () => {
    const browser = new Browser(`198.51.100.${++ipCounter}`, { target: plainEnv(), props: () => tenantProps() });
    const status = await (await browser.fetch("/api/auth/status")).json<Record<string, unknown>>();
    expect(status).not.toHaveProperty("hosted");
    expect(status.setupComplete).toBe(false);
  });

  it("keeps setup, recovery, the magic link and GitHub OAuth as they were", async () => {
    const browser = plainBrowser();
    const setup = await browser.fetch("/api/setup/state");
    expect(setup.status).toBe(503);
    expect(await setup.json()).toEqual({ error: "setup_token_not_configured" });

    const recover = await browser.fetch("/api/auth/passkeys/recover/options", { method: "POST", json: {} });
    expect(recover.status).toBe(409);
    expect(await recover.json()).toEqual({ error: "setup_incomplete" });

    const magic = await browser.fetch("/api/auth/magic/request", { method: "POST", json: { email: EMAIL } });
    expect(magic.status).toBe(200);

    const github = await browser.fetch("/auth/github/start");
    expect(github.status).toBe(302);
    expect(github.headers.get("location")).toBe(`${ORIGIN}/login?error=github_not_configured`);
  });

  it("serves /auth/hosted as any other client route, and never signs in", async () => {
    const browser = plainBrowser();
    const res = await browser.fetch(handoffPath(await token()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL);
    expect(browser.cookies.has("op_session")).toBe(false);
    expect(await nonceCount()).toBe(0);
  });

  it("serves /login as the app, signed out or not", async () => {
    const browser = plainBrowser();
    browser.cookies.set("op_signed_out", "1");
    const res = await browser.fetch("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL);
  });
});

describe("hosted mode", () => {
  it("answers 503 to a call without props, or with props it can't trust", async () => {
    const browser = hostedBrowser();
    const otherTenant = tenantProps();
    otherTenant.tenant = { ...otherTenant.tenant, id: OTHER_TENANT };
    for (const props of [undefined, {}, { ...tenantProps(), contract: 2 }, otherTenant]) {
      const res = await browser.fetch("/api/auth/status", { props });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "hosted_unavailable" });
    }
    const noTenantId = await browser.fetch("/api/auth/status", { target: hostedEnv({ TENANT_ID: undefined }) });
    expect(noTenantId.status).toBe(503);
  });

  it("refuses setup, recovery, the magic link and GitHub OAuth as managed by the platform", async () => {
    const browser = hostedBrowser();
    const target = hostedEnv({ SETUP_TOKEN: "a-setup-token", GITHUB_CLIENT_ID: "gh", GITHUB_CLIENT_SECRET: "s" });
    const headers = { "x-setup-token": "a-setup-token" };
    for (const [path, method] of [
      ["/api/setup/state", "GET"],
      ["/api/setup/save", "POST"],
      ["/api/setup/complete", "POST"],
      ["/api/setup/passkeys/options", "POST"],
      ["/api/auth/passkeys/recover/options", "POST"],
      ["/api/auth/passkeys/recover/verify", "POST"],
      ["/api/auth/magic/request", "POST"],
      ["/auth/magic/verify?token=x", "GET"],
      ["/auth/github/start", "GET"],
      ["/auth/github/callback?code=x&state=y", "GET"],
    ] as const) {
      const res = await browser.fetch(path, { method, headers, target, json: method === "POST" ? {} : undefined });
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: "managed_by_platform" });
    }
  });

  it("tells the sign-in screens setup is done and where the platform's sign-in is", async () => {
    const status = await (await hostedBrowser().fetch("/api/auth/status")).json<Record<string, unknown>>();
    expect(status).toMatchObject({
      setupComplete: true,
      githubEnabled: false,
      githubAdminConfigured: false,
      emailAdminConfigured: false,
      hosted: { signInUrl: URLS.signIn },
    });
  });

  it("doesn't let the customer move the address", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    const { csrf } = await browser.me();
    const res = await browser.fetch("/api/settings", {
      method: "PUT",
      headers: { "x-csrf-token": csrf! },
      json: { settings: { app_url: "https://elsewhere.test/" } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "managed_by_platform", key: "app_url" });
    const timezone = await browser.fetch("/api/settings", {
      method: "PUT",
      headers: { "x-csrf-token": csrf! },
      json: { settings: { timezone: "Europe/Berlin" } },
    });
    expect(timezone.status).toBe(200);
  });
});

describe("the sign-in hand-off", () => {
  it("signs a customer in with a valid token and lands on the dashboard", async () => {
    const browser = hostedBrowser();
    const res = await browser.fetch(handoffPath(await token()));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(browser.cookies.has("op_session")).toBe(true);

    const me = await browser.me();
    expect(me).toMatchObject({
      authenticated: true,
      identity: EMAIL,
      identityKind: "hosted",
      hosted: {
        slug: "acme",
        plan: "trial",
        status: "trial",
        accountUrl: URLS.account,
        billingUrl: URLS.billing,
        signOutUrl: URLS.signOut,
      },
    });
    expect(me.expiresAt! - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "session.created",
        actor: "customer",
        detail: { method: "handoff", role: "customer", account: "acct_1" },
      }),
    ]);

    // The session works for the admin API like any other.
    expect((await browser.fetch("/api/monitors")).status).toBe(200);
  });

  it("signs support in for an hour, and only when the platform records it", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token({ role: "support" })))).status).toBe(302);
    const me = await browser.me();
    expect(me).toMatchObject({ authenticated: true, identity: EMAIL, identityKind: "hosted_support" });
    expect(me.expiresAt! - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(audits).toEqual([expect.objectContaining({ action: "session.created", actor: "support" })]);

    auditFails = true;
    const unaudited = hostedBrowser();
    const refused = await unaudited.fetch(handoffPath(await token({ role: "support" })));
    expect(refused.status).toBe(503);
    expect(unaudited.cookies.has("op_session")).toBe(false);

    // A customer's sign-in doesn't wait on the audit log.
    const customer = hostedBrowser();
    expect((await customer.fetch(handoffPath(await token()))).status).toBe(302);
    expect((await customer.me()).authenticated).toBe(true);
  });

  it("refuses expired, wrong-audience, bad-signature, malformed and too-long tokens", async () => {
    const other = await importHandoffPrivateKey((await generateHandoffKeyPair()).privateKey);
    const now = Date.now();
    const valid = await token();
    const [prefix, payload, signature] = valid.split(".");
    const tampered = `${prefix}.${payload!.slice(0, -2)}AA.${signature}`;
    const before = await nonceCount();
    const cases: Array<[string, string]> = [
      ["expired", handoffPath(await token({}, signingKey, now - 120_000))],
      ["not yet valid", handoffPath(await token({}, signingKey, now + 60_000))],
      ["lifetime too long", handoffPath(await token({ exp: Math.floor(now / 1000) + 3600 }))],
      ["wrong audience", handoffPath(await token({ aud: OTHER_TENANT }))],
      ["wrong issuer", handoffPath(await token({ iss: "someone-else" as "openping-platform" }))],
      ["bad signature", handoffPath(await token({}, other))],
      ["tampered payload", handoffPath(tampered)],
      ["malformed", handoffPath("v1.not-a-token")],
      ["another format", handoffPath(valid.replace(/^v1\./, "v2."))],
      ["no token", "/auth/hosted"],
      ["empty token", "/auth/hosted?t="],
      ["two tokens", `${handoffPath(valid)}&t=${encodeURIComponent(valid)}`],
      ["too long", handoffPath(`v1.${"A".repeat(2100)}.${signature}`)],
    ];
    for (const [name, path] of cases) {
      const browser = hostedBrowser();
      const res = await browser.fetch(path);
      expect([name, res.status]).toEqual([name, 400]);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("This sign-in link has expired");
      expect(html).toContain(`href="${URLS.signIn}"`);
      expect(browser.cookies.has("op_session")).toBe(false);
    }
    // Nothing unsigned or refused reaches the nonce table.
    expect(await nonceCount()).toBe(before);
    expect(audits).toEqual([]);
  });

  it("refuses a replayed token, even from another browser", async () => {
    const t = await token();
    const first = hostedBrowser();
    expect((await first.fetch(handoffPath(t))).status).toBe(302);
    for (const browser of [first, hostedBrowser()]) {
      const before = await browser.me();
      const res = await browser.fetch(handoffPath(t));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("This sign-in link has expired");
      if (!before.authenticated) expect(browser.cookies.has("op_session")).toBe(false);
    }
    expect(audits).toHaveLength(1);
  });

  it("lets exactly one of two racing requests use a token", async () => {
    const t = await token();
    const [a, b] = [hostedBrowser(), hostedBrowser()];
    const statuses = (await Promise.all([a.fetch(handoffPath(t)), b.fetch(handoffPath(t))])).map((r) => r.status);
    expect(statuses.sort()).toEqual([302, 400]);
  });

  it("keeps each nonce until past every possible expiry", async () => {
    const now = Date.now();
    const t = await token({}, signingKey, now);
    expect((await hostedBrowser().fetch(handoffPath(t))).status).toBe(302);
    const exp = Math.floor(now / 1000) + 60;
    const row = await env.DB.prepare("SELECT expires_at FROM used_handoff_nonces ORDER BY used_at DESC LIMIT 1").first<{
      expires_at: number;
    }>();
    expect(row!.expires_at).toBe((exp + HANDOFF_NONCE_RETENTION_SECONDS) * 1000);
  });

  it("shows the error page when HANDOFF_PUBLIC_KEY is missing", async () => {
    const browser = hostedBrowser();
    const res = await browser.fetch(handoffPath(await token()), { target: hostedEnv({ HANDOFF_PUBLIC_KEY: undefined }) });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(`href="${URLS.signIn}"`);
    expect(browser.cookies.has("op_session")).toBe(false);
  });

  it("replaces a session the browser already had", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    const firstCookie = browser.cookies.get("op_session");
    const sessionsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    expect(browser.cookies.get("op_session")).not.toBe(firstCookie);
    const sessionsAfter = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
    expect(sessionsAfter).toBe(sessionsBefore);
  });
});

describe("signing out in hosted mode", () => {
  it("continues to the platform's sign-out", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    const { csrf } = await browser.me();
    const out = await browser.fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": csrf! } });
    expect(await out.json()).toEqual({ ok: true, signOutUrl: URLS.signOut });
    expect((await browser.me()).authenticated).toBe(false);

    // The app goes to /login next, which sends this browser on to the platform once.
    const login = await browser.fetch("/login");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(URLS.signOut);
    const again = await browser.fetch("/login");
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(SHELL);
  });

  it("does the same after signing out everywhere", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    const { csrf } = await browser.me();
    const out = await browser.fetch("/api/auth/logout-all", { method: "POST", headers: { "x-csrf-token": csrf! } });
    expect(await out.json()).toEqual({ ok: true, signOutUrl: URLS.signOut });
    expect((await browser.fetch("/login")).headers.get("location")).toBe(URLS.signOut);
  });

  it("is unchanged on a plain install", async () => {
    const browser = plainBrowser();
    browser.cookies.set("op_session", "not-a-session");
    const out = await browser.fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": "x" } });
    expect(out.status).toBe(401);
  });
});

describe("the customer's own passkeys in hosted mode", () => {
  it("can be added, used to sign in, and the last one removed", async () => {
    const browser = hostedBrowser();
    expect((await browser.fetch(handoffPath(await token()))).status).toBe(302);
    const authenticator = await SoftAuthenticator.create();
    const { csrf } = await browser.me();

    const optRes = await browser.fetch("/api/passkeys/register/options", {
      method: "POST",
      json: { name: "Phone" },
      headers: { "x-csrf-token": csrf! },
    });
    expect(optRes.status).toBe(200);
    const { options } = await optRes.json<{ options: Parameters<SoftAuthenticator["register"]>[0] }>();
    const verify = await browser.fetch("/api/passkeys/register/verify", {
      method: "POST",
      json: { credential: await authenticator.register(options, ORIGIN) },
      headers: { "x-csrf-token": csrf! },
    });
    expect(verify.status).toBe(201);
    const { passkey } = await verify.json<{ passkey: { id: string } }>();

    const list = await (await browser.fetch("/api/passkeys")).json<{ otherSignIn: Record<string, unknown> }>();
    expect(list.otherSignIn).toEqual({ github: false, email: false, hosted: true });

    // A fresh browser signs in with the passkey alone.
    const phone = hostedBrowser();
    const loginOptions = await phone.fetch("/api/auth/passkeys/login/options", { method: "POST", json: {} });
    expect(loginOptions.status).toBe(200);
    const { options: requestOptions } = await loginOptions.json<{
      options: Parameters<SoftAuthenticator["authenticate"]>[0];
    }>();
    const signIn = await phone.fetch("/api/auth/passkeys/login/verify", {
      method: "POST",
      json: { credential: await authenticator.authenticate(requestOptions, ORIGIN) },
    });
    expect(signIn.status).toBe(200);
    expect(await phone.me()).toMatchObject({ authenticated: true, identityKind: "passkey" });

    // The platform's sign-in is always a way back in, so the only passkey can go.
    const remove = await browser.fetch(`/api/passkeys/${encodeURIComponent(passkey.id)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf! },
    });
    expect(remove.status).toBe(200);
  });
});

describe("nonce cleanup", () => {
  it("deletes expired nonces with the rest of the expired auth state", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO used_handoff_nonces (nonce, used_at, expires_at) VALUES (?, ?, ?)").bind(
        "expiredexpiredexpired0",
        now - 200_000,
        now - 1,
      ),
      env.DB.prepare("INSERT INTO used_handoff_nonces (nonce, used_at, expires_at) VALUES (?, ?, ?)").bind(
        "currentcurrentcurrent0",
        now,
        now + 65_000,
      ),
    ]);
    const statements = expiredAuthCleanupStatements(env as Env, now);
    expect(statements.map((s) => s.label)).toContain("expired-handoff-nonce cleanup");
    await env.DB.batch(statements.map((s) => s.stmt));
    const left = await env.DB.prepare("SELECT nonce FROM used_handoff_nonces WHERE nonce IN (?, ?)")
      .bind("expiredexpiredexpired0", "currentcurrentcurrent0")
      .all<{ nonce: string }>();
    expect(left.results.map((r) => r.nonce)).toEqual(["currentcurrentcurrent0"]);
  });
});
