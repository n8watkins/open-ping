import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { randomToken, sha256hex } from "../../src/worker/lib/ids";

/**
 * Named API tokens end to end through the real Worker and D1: created from a
 * browser session (shown once, stored as a hash), used by the REST API and
 * the MCP server, never able to mint or revoke tokens itself, and dead the
 * moment it is revoked.
 */

const ORIGIN = "https://openping.test";
const SECRET = "integration-api-token";

/** An install with no API_TOKEN secret, where only stored tokens work. */
const noSecret = { ...env, API_TOKEN: undefined } as Env;

interface Session {
  cookie: string;
  csrf: string;
}

/** A signed-in browser session, written the way lib/sessions.ts writes one. */
async function signIn(): Promise<Session> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, identity, identity_kind, csrf_secret, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, 'owner', 'github', ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(await sha256hex(token), csrf, now, now + 3_600_000, now)
    .run();
  return { cookie: `op_session=${token}`, csrf };
}

async function call(
  path: string,
  init: { method?: string; json?: unknown; headers?: Record<string, string>; target?: Env } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }),
    init.target ?? (env as Env),
    createExecutionContext(),
  );
}

const asSession = (s: Session, extra: Record<string, string> = {}) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, ...extra });
const asBearer = (token: string) => ({ authorization: `Bearer ${token}` });

function mcpInitialize(token: string | null, target?: Env): Promise<Response> {
  return call("/mcp", {
    json: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tokens", version: "1" } },
    },
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? asBearer(token) : {}),
    },
    target,
  });
}

async function createToken(s: Session, name: string): Promise<{ token: string; id: string }> {
  const res = await call("/api/api-tokens", { json: { name }, headers: asSession(s) });
  expect(res.status).toBe(201);
  const body = await res.json<{ token: string; apiToken: { id: string } }>();
  return { token: body.token, id: body.apiToken.id };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("API tokens", () => {
  it("are off for MCP until a token exists, and a stored token turns MCP on without the secret", async () => {
    const off = await mcpInitialize(null, noSecret);
    expect(off.status).toBe(404);
    expect((await off.json<{ error: string }>()).error).toBe("mcp_disabled");

    const owner = await signIn();
    const { token, id } = await createToken(owner, "Claude Code");

    const anonymous = await mcpInitialize(null, noSecret);
    expect(anonymous.status).toBe(401);
    const ok = await mcpInitialize(token, noSecret);
    expect(ok.status).toBe(200);

    await call(`/api/api-tokens/${id}`, { method: "DELETE", headers: asSession(owner) });
    expect((await mcpInitialize(token, noSecret)).status).toBe(404);
  });

  it("are shown once and stored only as a hash", async () => {
    const owner = await signIn();
    const res = await call("/api/api-tokens", { json: { name: "  CI deploy check  " }, headers: asSession(owner) });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = await res.json<{ token: string; apiToken: { id: string; name: string; prefix: string } }>();
    expect(created.token).toMatch(/^opk_[A-Za-z0-9_-]{43}$/);
    expect(created.apiToken.name).toBe("CI deploy check");
    expect(created.token.startsWith(created.apiToken.prefix)).toBe(true);

    const row = await env.DB.prepare("SELECT * FROM api_tokens WHERE id = ?").bind(created.apiToken.id).first();
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row?.token_hash).toBe(await sha256hex(created.token));

    const list = await call("/api/api-tokens", { headers: { cookie: owner.cookie } });
    const text = await list.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(String(row?.token_hash));
    const body = JSON.parse(text) as { tokens: { id: string; lastUsedAt: number | null }[]; secretConfigured: boolean };
    expect(body.secretConfigured).toBe(true);
    expect(body.tokens.find((t) => t.id === created.apiToken.id)?.lastUsedAt).toBeNull();
  });

  it("authenticate the REST API and MCP, and record when they were last used", async () => {
    const owner = await signIn();
    const { token, id } = await createToken(owner, "Laptop CLI");

    expect((await call("/api/overview", { headers: asBearer(token) })).status).toBe(200);
    expect((await mcpInitialize(token)).status).toBe(200);
    expect((await call("/api/overview", { headers: asBearer(`${token}x`) })).status).toBe(401);

    const row = await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").bind(id).first<{ last_used_at: number }>();
    expect(row?.last_used_at).toBeGreaterThan(0);
    // The secret keeps working beside stored tokens.
    expect((await call("/api/overview", { headers: asBearer(SECRET) })).status).toBe(200);
  });

  it("cannot be created or revoked with a token, or without the session's CSRF token", async () => {
    const owner = await signIn();
    const { token, id } = await createToken(owner, "Script");

    const minted = await call("/api/api-tokens", { json: { name: "Escalation" }, headers: asBearer(token) });
    expect(minted.status).toBe(403);
    expect((await minted.json<{ error: string }>()).error).toBe("session_required");
    expect((await call(`/api/api-tokens/${id}`, { method: "DELETE", headers: asBearer(SECRET) })).status).toBe(403);

    const noCsrf = await call("/api/api-tokens", { json: { name: "No CSRF" }, headers: { cookie: owner.cookie } });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json<{ error: string }>()).error).toBe("csrf_failed");

    // Listing is read-only, so a token may do it.
    expect((await call("/api/api-tokens", { headers: asBearer(token) })).status).toBe(200);
  });

  it("validate the name", async () => {
    const owner = await signIn();
    for (const name of ["", "   ", "x".repeat(65)]) {
      const res = await call("/api/api-tokens", { json: { name }, headers: asSession(owner) });
      expect(res.status).toBe(400);
    }
    expect((await call("/api/api-tokens", { json: {}, headers: asSession(owner) })).status).toBe(400);
  });

  it("stop working the moment they are revoked", async () => {
    const owner = await signIn();
    const { token, id } = await createToken(owner, "Old laptop");
    expect((await call("/api/overview", { headers: asBearer(token) })).status).toBe(200);

    const revoked = await call(`/api/api-tokens/${id}`, { method: "DELETE", headers: asSession(owner) });
    expect(revoked.status).toBe(200);
    expect((await call("/api/overview", { headers: asBearer(token) })).status).toBe(401);
    expect((await mcpInitialize(token)).status).toBe(401);

    const again = await call(`/api/api-tokens/${id}`, { method: "DELETE", headers: asSession(owner) });
    expect(again.status).toBe(404);
  });
});
