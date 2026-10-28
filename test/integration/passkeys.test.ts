import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { COSE_ALG_RS256 } from "../../src/worker/lib/webauthn";
import { SoftAuthenticator } from "../support/soft-authenticator";

/**
 * Passkeys end to end through the real Worker and D1: create the first passkey
 * in the setup wizard, finish setup with no GitHub or email admin, sign in,
 * manage passkeys from Settings, and recover with a new SETUP_TOKEN. The
 * authenticator is a software one with real Web Crypto keys.
 */

const ORIGIN = "https://openping.test";
const RP_ID = "openping.test";
const API_TOKEN = "integration-api-token";
const FIRST_TOKEN = `setup-${crypto.randomUUID()}`;
const RECOVERY_TOKEN = `recovery-${crypto.randomUUID()}`;

const envWith = (setupToken: string): Env => ({ ...env, SETUP_TOKEN: setupToken }) as Env;

/** A tiny cookie jar: one per simulated browser. */
class Browser {
  cookies = new Map<string, string>();
  constructor(readonly ip: string) {}

  async fetch(path: string, init: RequestInit & { json?: unknown; target?: Env } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.ip);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await worker.fetch(
      new Request(`${ORIGIN}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }),
      init.target ?? (env as Env),
      createExecutionContext(),
    );
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (!value || expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  async csrf(): Promise<string> {
    const me = await (await this.fetch("/api/auth/me")).json<{ authenticated: boolean; csrf?: string }>();
    expect(me.authenticated).toBe(true);
    return me.csrf!;
  }
}

type Options = { challenge: string; rp: { id: string }; user: { id: string }; rpId: string };

async function signIn(browser: Browser, auth: SoftAuthenticator) {
  const optRes = await browser.fetch("/api/auth/passkeys/login/options", { method: "POST", json: {} });
  expect(optRes.status).toBe(200);
  const { options } = await optRes.json<{ options: Options }>();
  const credential = await auth.authenticate(options, ORIGIN);
  return browser.fetch("/api/auth/passkeys/login/verify", { method: "POST", json: { credential } });
}

async function addPasskeyInSettings(browser: Browser, auth: SoftAuthenticator, name: string) {
  const csrf = await browser.csrf();
  const optRes = await browser.fetch("/api/passkeys/register/options", {
    method: "POST",
    json: { name },
    headers: { "x-csrf-token": csrf },
  });
  expect(optRes.status).toBe(200);
  const { options } = await optRes.json<{ options: Options }>();
  const credential = await auth.register(options, ORIGIN);
  return browser.fetch("/api/passkeys/register/verify", {
    method: "POST",
    json: { credential },
    headers: { "x-csrf-token": csrf },
  });
}

let laptop: SoftAuthenticator;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  laptop = await SoftAuthenticator.create();
});

describe("passkeys", () => {
  it("creates the first passkey in setup and finishes setup without GitHub or email", async () => {
    const setupEnv = envWith(FIRST_TOKEN);
    const owner = new Browser("198.51.100.1");
    const status = await (await owner.fetch("/api/auth/status", { target: setupEnv })).json<Record<string, unknown>>();
    expect(status).toMatchObject({ passkeyConfigured: false, passkeyRpId: RP_ID, setupComplete: false });

    // The setup token guards the wizard's passkey step like every other step.
    const anonymous = await owner.fetch("/api/setup/passkeys/options", { method: "POST", json: {}, target: setupEnv });
    expect(anonymous.status).toBe(403);

    const tokenHeader = { "x-setup-token": FIRST_TOKEN };
    const optRes = await owner.fetch("/api/setup/passkeys/options", {
      method: "POST",
      json: { name: "Laptop" },
      headers: tokenHeader,
      target: setupEnv,
    });
    expect(optRes.status).toBe(200);
    const { options } = await optRes.json<{ options: Options & Record<string, unknown> }>();
    expect(options).toMatchObject({
      rp: { id: RP_ID, name: "OpenPing" },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      pubKeyCredParams: [{ alg: -7 }, { alg: -257 }],
    });
    expect(owner.cookies.get("op_passkey")).toBe(options.challenge);
    // Only the challenge's hash is stored.
    const stored = await env.DB.prepare("SELECT id FROM auth_tokens WHERE kind = 'passkey_register'").all<{ id: string }>();
    expect(stored.results.map((r) => r.id)).not.toContain(options.challenge);

    const credential = await laptop.register(options, ORIGIN);
    const verify = await owner.fetch("/api/setup/passkeys/verify", {
      method: "POST",
      json: { credential },
      headers: tokenHeader,
      target: setupEnv,
    });
    expect(verify.status).toBe(201);
    expect((await verify.json<{ status: { passkeyCount: number } }>()).status.passkeyCount).toBe(1);

    const save = await owner.fetch("/api/setup/save", {
      method: "POST",
      json: { step: 4, stepId: "admin", data: { timezone: "UTC" } },
      headers: tokenHeader,
      target: setupEnv,
    });
    expect(save.status).toBe(200);
    const complete = await owner.fetch("/api/setup/complete", {
      method: "POST",
      json: {},
      headers: tokenHeader,
      target: setupEnv,
    });
    expect(complete.status).toBe(200);
    // Setup creates no session: the owner signs in with the new passkey.
    expect(owner.cookies.has("op_session")).toBe(false);

    const after = await (await owner.fetch("/api/auth/status")).json<Record<string, unknown>>();
    expect(after).toMatchObject({ passkeyConfigured: true, setupComplete: true, githubAdminConfigured: false, emailAdminConfigured: false });
  });

  it("signs in with the passkey into a normal session with CSRF", async () => {
    const browser = new Browser("198.51.100.2");
    const res = await signIn(browser, laptop);
    expect(res.status).toBe(200);
    expect(browser.cookies.has("op_session")).toBe(true);
    expect(browser.cookies.has("op_passkey")).toBe(false);

    const me = await (await browser.fetch("/api/auth/me")).json<Record<string, unknown>>();
    expect(me).toMatchObject({ authenticated: true, identityKind: "passkey", identity: "Laptop" });
    const session = await env.DB.prepare("SELECT identity, identity_kind FROM sessions WHERE identity_kind = 'passkey'").first<{
      identity: string;
    }>();
    expect(session?.identity).toMatch(/^pk_/);

    // Mutations still need the session's CSRF token.
    const noCsrf = await browser.fetch("/api/passkeys/register/options", { method: "POST", json: {} });
    expect(noCsrf.status).toBe(403);
    const list = await (await browser.fetch("/api/passkeys")).json<{
      passkeys: { name: string; lastUsedAt: number | null }[];
      rpId: string;
    }>();
    expect(list.rpId).toBe(RP_ID);
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]!.lastUsedAt).not.toBeNull();
  });

  it("makes each challenge single use, short-lived and bound to its browser", async () => {
    const browser = new Browser("198.51.100.3");
    const optRes = await browser.fetch("/api/auth/passkeys/login/options", { method: "POST", json: {} });
    const { options } = await optRes.json<{ options: Options }>();
    const credential = await laptop.authenticate(options, ORIGIN);
    const cookie = browser.cookies.get("op_passkey")!;

    // Another browser (no challenge cookie) can't answer it, and trying burns it.
    const thief = new Browser("198.51.100.4");
    const stolen = await thief.fetch("/api/auth/passkeys/login/verify", { method: "POST", json: { credential } });
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toEqual({ error: "challenge_invalid" });
    browser.cookies.set("op_passkey", cookie);
    const burned = await browser.fetch("/api/auth/passkeys/login/verify", { method: "POST", json: { credential } });
    expect(await burned.json()).toEqual({ error: "challenge_invalid" });

    // Replay of a successful response.
    const good = await signIn(browser, laptop);
    expect(good.status).toBe(200);

    // Expired.
    const late = new Browser("198.51.100.5");
    const lateOpts = await (await late.fetch("/api/auth/passkeys/login/options", { method: "POST", json: {} })).json<{
      options: Options;
    }>();
    await env.DB.prepare("UPDATE auth_tokens SET expires_at = ? WHERE kind = 'passkey_login'").bind(Date.now() - 1).run();
    const expired = await late.fetch("/api/auth/passkeys/login/verify", {
      method: "POST",
      json: { credential: await laptop.authenticate(lateOpts.options, ORIGIN) },
    });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "challenge_invalid" });
    expect(late.cookies.has("op_session")).toBe(false);
  });

  it("rejects the wrong origin and RP ID", async () => {
    const browser = new Browser("198.51.100.6");
    const opts = async () =>
      (await (await browser.fetch("/api/auth/passkeys/login/options", { method: "POST", json: {} })).json<{ options: Options }>())
        .options;

    const fromElsewhere = await browser.fetch("/api/auth/passkeys/login/verify", {
      method: "POST",
      json: { credential: await laptop.authenticate(await opts(), ORIGIN) },
      headers: { origin: "https://evil.example" },
    });
    expect(fromElsewhere.status).toBe(403);

    for (const [overrides, reason] of [
      [{ origin: "https://open-ping.someone.workers.dev" }, "origin_mismatch"],
      [{ rpId: "open-ping.someone.workers.dev" }, "rp_id_mismatch"],
    ] as const) {
      const res = await browser.fetch("/api/auth/passkeys/login/verify", {
        method: "POST",
        json: { credential: await laptop.authenticate(await opts(), ORIGIN, overrides) },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "passkey_invalid", reason });
    }
    expect(browser.cookies.has("op_session")).toBe(false);
  });

  it("refuses an unknown passkey and a counter that went backwards", async () => {
    const browser = new Browser("198.51.100.7");
    const stranger = await SoftAuthenticator.create();
    stranger.userHandle = laptop.userHandle;
    const unknown = await signIn(browser, stranger);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "unknown_passkey" });

    laptop.setCounter(0);
    const cloned = await signIn(browser, laptop);
    expect(cloned.status).toBe(401);
    expect(await cloned.json()).toEqual({ error: "passkey_invalid", reason: "counter_regressed" });
    laptop.setCounter(1000);
  });

  it("adds and removes passkeys from Settings, and removing one ends its sessions", async () => {
    const browser = new Browser("198.51.100.8");
    expect((await signIn(browser, laptop)).status).toBe(200);

    const phone = await SoftAuthenticator.create({ alg: COSE_ALG_RS256, counter: false });
    const added = await addPasskeyInSettings(browser, phone, "Phone");
    expect(added.status).toBe(201);
    expect((await added.json<{ passkey: { name: string } }>()).passkey.name).toBe("Phone");

    // The same authenticator can't be added twice.
    const again = await addPasskeyInSettings(browser, phone, "Phone again");
    expect(again.status).toBe(409);

    // The API token can list but not register (no authenticator behind it).
    const bearer = { authorization: `Bearer ${API_TOKEN}` };
    const listed = await (await browser.fetch("/api/passkeys", { headers: bearer })).json<{ passkeys: { id: string; name: string }[] }>();
    expect(listed.passkeys.map((p) => p.name)).toEqual(["Laptop", "Phone"]);
    const tokenRegister = await new Browser("198.51.100.9").fetch("/api/passkeys/register/options", {
      method: "POST",
      json: {},
      headers: bearer,
    });
    expect(tokenRegister.status).toBe(403);

    const phoneBrowser = new Browser("198.51.100.10");
    expect((await signIn(phoneBrowser, phone)).status).toBe(200);
    expect((await phoneBrowser.fetch("/api/auth/me")).status).toBe(200);

    const phoneId = listed.passkeys.find((p) => p.name === "Phone")!.id;
    const csrf = await browser.csrf();
    const removed = await browser.fetch(`/api/passkeys/${phoneId}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
    expect(removed.status).toBe(200);
    const phoneMe = await (await phoneBrowser.fetch("/api/auth/me")).json<{ authenticated: boolean }>();
    expect(phoneMe.authenticated).toBe(false);

    // The last passkey can't be removed while it is the only way in.
    const laptopId = listed.passkeys.find((p) => p.name === "Laptop")!.id;
    const last = await browser.fetch(`/api/passkeys/${laptopId}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: "last_sign_in_method" });

    // A passkey for another hostname (left over from an earlier APP_URL) can't
    // sign in here, so it doesn't count as another way in...
    await env.DB.prepare(
      `INSERT INTO passkeys (id, credential_id, public_key, alg, sign_count, rp_id, name, created_at)
       SELECT 'pk_stale', 'stale-credential', public_key, alg, 0, 'old.openping.test', 'Old laptop', created_at
       FROM passkeys WHERE id = ?`,
    )
      .bind(laptopId)
      .run();
    const withStale = await browser.fetch(`/api/passkeys/${laptopId}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
    expect(withStale.status).toBe(409);
    expect(await withStale.json()).toEqual({ error: "last_sign_in_method" });
    // ...and removing it never takes away a way in.
    const stale = await browser.fetch("/api/passkeys/pk_stale", { method: "DELETE", headers: { "x-csrf-token": csrf } });
    expect(stale.status).toBe(200);
  });

  it("recovers with a new SETUP_TOKEN, once", async () => {
    // The token that set the install up is spent.
    const owner = new Browser("198.51.100.11");
    const old = await owner.fetch("/api/auth/passkeys/recover/options", {
      method: "POST",
      json: {},
      headers: { "x-setup-token": FIRST_TOKEN },
      target: envWith(FIRST_TOKEN),
    });
    expect(old.status).toBe(403);
    expect(await old.json()).toEqual({ error: "setup_token_spent" });

    const recoveryEnv = envWith(RECOVERY_TOKEN);
    const wrong = await owner.fetch("/api/auth/passkeys/recover/options", {
      method: "POST",
      json: {},
      headers: { "x-setup-token": FIRST_TOKEN },
      target: recoveryEnv,
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "setup_token_invalid" });

    const header = { "x-setup-token": RECOVERY_TOKEN };
    const optRes = await owner.fetch("/api/auth/passkeys/recover/options", {
      method: "POST",
      json: { name: "New laptop" },
      headers: header,
      target: recoveryEnv,
    });
    expect(optRes.status).toBe(200);
    const { options } = await optRes.json<{ options: Options & { excludeCredentials: unknown[] } }>();
    expect(options.excludeCredentials).toHaveLength(1);
    const replacement = await SoftAuthenticator.create();
    const verify = await owner.fetch("/api/auth/passkeys/recover/verify", {
      method: "POST",
      json: { credential: await replacement.register(options, ORIGIN) },
      headers: header,
      target: recoveryEnv,
    });
    expect(verify.status).toBe(201);
    expect(owner.cookies.has("op_session")).toBe(true);
    const me = await (await owner.fetch("/api/auth/me")).json<Record<string, unknown>>();
    expect(me).toMatchObject({ authenticated: true, identity: "New laptop", identityKind: "passkey" });

    const reuse = await new Browser("198.51.100.12").fetch("/api/auth/passkeys/recover/options", {
      method: "POST",
      json: {},
      headers: header,
      target: recoveryEnv,
    });
    expect(reuse.status).toBe(403);
    expect(await reuse.json()).toEqual({ error: "setup_token_spent" });
  });

  it("signs out everywhere, whatever the sign-in method", async () => {
    const a = new Browser("198.51.100.13");
    const b = new Browser("198.51.100.14");
    expect((await signIn(a, laptop)).status).toBe(200);
    expect((await signIn(b, laptop)).status).toBe(200);
    const res = await a.fetch("/api/auth/logout-all", { method: "POST", headers: { "x-csrf-token": await a.csrf() } });
    expect(res.status).toBe(200);
    expect((await (await b.fetch("/api/auth/me")).json<{ authenticated: boolean }>()).authenticated).toBe(false);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
