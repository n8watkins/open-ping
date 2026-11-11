import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { randomToken, sha256hex } from "../../src/worker/lib/ids";
import { normalizeScopes, TOOL_SCOPES } from "../../src/worker/lib/scopes";
import { PERMISSIONS } from "../../src/shared/scopes";
import { API_TOKEN_RATE_LIMIT_PER_MINUTE, requireAuth } from "../../src/worker/middleware/auth";
import { Hono } from "hono";
import type { AppEnv } from "../../src/worker/types";

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

async function createToken(
  s: Session,
  name: string,
  extra: { scopes?: string[]; expiresInDays?: number | null } = {},
): Promise<{ token: string; id: string }> {
  const res = await call("/api/api-tokens", { json: { name, ...extra }, headers: asSession(s) });
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
    // The 'v2:' form, which an older OpenPing (a rollback) never matches.
    expect(row?.token_hash).toBe(`v2:${await sha256hex(created.token)}`);
    expect(row?.scopes).toBe("admin");
    expect(row?.expires_at).toBeNull();
    expect(row?.created_via).toBe("github:owner");

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

    // No token, not even an admin one or the secret, may list tokens either.
    for (const bearer of [token, SECRET]) {
      const listed = await call("/api/api-tokens", { headers: asBearer(bearer) });
      expect(listed.status).toBe(403);
      expect((await listed.json<{ error: string }>()).error).toBe("session_required");
    }
    // A token may only describe itself.
    const self = await call("/api/api-tokens/self", { headers: asBearer(token) });
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ kind: "token", id, name: "Script", scopes: ["admin"], expiresAt: null });
    expect(await (await call("/api/api-tokens/self", { headers: asBearer(SECRET) })).json()).toMatchObject({
      kind: "secret",
      scopes: ["admin"],
    });
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

    // The row stays as an audit record, with its hash destroyed.
    const row = await env.DB.prepare("SELECT token_hash, revoked_at FROM api_tokens WHERE id = ?")
      .bind(id)
      .first<{ token_hash: string; revoked_at: number }>();
    expect(row?.revoked_at).toBeGreaterThan(0);
    expect(row?.token_hash).toBe(`revoked:${id}`);
    const list = await (await call("/api/api-tokens", { headers: { cookie: owner.cookie } })).json<{
      tokens: { id: string }[];
      revoked: { id: string; revokedAt: number }[];
    }>();
    expect(list.tokens.some((t) => t.id === id)).toBe(false);
    expect(list.revoked.find((t) => t.id === id)?.revokedAt).toBe(row?.revoked_at);
  });

  it("accept a custom expiry date and reject past or too-distant ones", async () => {
    const owner = await signIn();
    const day = 86_400_000;
    const ok = Date.now() + 30 * day;
    const res = await call("/api/api-tokens", {
      json: { name: "Custom", scopes: ["read"], expiresAt: ok },
      headers: asSession(owner),
    });
    expect(res.status).toBe(201);
    const { apiToken } = await res.json<{
      apiToken: { id: string; expiresAt: number };
    }>();
    expect(apiToken.expiresAt).toBe(ok);
    const row = await env.DB.prepare(
      "SELECT expires_at FROM api_tokens WHERE id = ?",
    )
      .bind(apiToken.id)
      .first<{ expires_at: number }>();
    expect(row?.expires_at).toBe(ok);

    for (const [expiresAt, message] of [
      [Date.now() - day, "must be in the future"],
      [Date.now() + 400 * day, "at most 1 year"],
    ] as const) {
      const bad = await call("/api/api-tokens", {
        json: { name: "Bad", scopes: ["read"], expiresAt },
        headers: asSession(owner),
      });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(await bad.json())).toContain(message);
    }
  });

  it("validate scopes and expiry", async () => {
    const owner = await signIn();
    for (const extra of [{ scopes: [] }, { scopes: ["write"] }, { expiresInDays: 5 }, { expiresInDays: "30" }]) {
      const res = await call("/api/api-tokens", { json: { name: "Bad", ...extra }, headers: asSession(owner) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

/** A token with exactly these scopes, from a fresh owner session. */
async function scopedToken(scopes: string[], extra: { expiresInDays?: number | null } = {}): Promise<string> {
  // Stay under MAX_API_TOKENS across the file: only the newest few are still in use by a test.
  await env.DB.prepare(
    "DELETE FROM api_tokens WHERE revoked_at IS NULL AND id NOT IN (SELECT id FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 10)",
  ).run();
  return (await createToken(await signIn(), scopes.join("+").slice(0, 64), { scopes, ...extra })).token;
}

/** A monitor and a not-yet-started and a running maintenance window, made by the owner. */
async function fixtures(): Promise<{ monitorId: string; upcoming: string; active: string }> {
  const now = Date.now();
  const monitor = await call("/api/monitors", {
    json: { type: "heartbeat", name: "Scoped fixture", config: { intervalSeconds: 3600, graceSeconds: 300 } },
    headers: asBearer(SECRET),
  });
  expect(monitor.status).toBe(201);
  const window = async (startsAt: number) => {
    const res = await call("/api/maintenance", {
      json: { title: "Fixture", scope: "global", startsAt, endsAt: startsAt + 3_600_000 },
      headers: asBearer(SECRET),
    });
    expect(res.status).toBe(201);
    return (await res.json<{ window: { id: string } }>()).window.id;
  };
  return {
    monitorId: (await monitor.json<{ monitor: { id: string } }>()).monitor.id,
    upcoming: await window(now + 86_400_000),
    active: await window(now - 60_000),
  };
}

type Probe = [method: string, path: string, json?: unknown];

async function expectAllowed(token: string, probes: Probe[]): Promise<void> {
  for (const [method, path, json] of probes) {
    const res = await call(path, { method, json, headers: asBearer(token) });
    expect([401, 403, 429], `${method} ${path} -> ${res.status}`).not.toContain(res.status);
  }
}

async function expectRefused(token: string, probes: Probe[], required: string): Promise<void> {
  for (const [method, path, json] of probes) {
    const res = await call(path, { method, json, headers: asBearer(token) });
    expect(res.status, `${method} ${path}`).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain(`scope="${required}"`);
    const body = await res.json<{ error: string; required: string; message: string }>();
    expect(body, `${method} ${path}`).toMatchObject({ error: "insufficient_scope", required });
    expect(body.message).toContain(required);
  }
}

describe("scoped tokens", () => {
  it("get exactly the pairs ticked, plus the read each edit implies", async () => {
    const owner = await signIn();
    const res = await call("/api/api-tokens", { json: { name: "Pairs", scopes: ["monitors:edit", "incidents:read"] }, headers: asSession(owner) });
    expect(res.status).toBe(201);
    const { token } = await res.json<{ token: string }>();
    expect(await (await call("/api/api-tokens/self", { headers: asBearer(token) })).json()).toMatchObject({
      scopes: ["monitors:read", "monitors:edit", "incidents:read"],
    });
    const { monitorId } = await fixtures();
    await expectAllowed(token, [
      ["GET", "/api/monitors"],
      ["POST", `/api/monitors/${monitorId}/pause`],
      ["GET", "/api/incidents"],
    ]);
    await expectRefused(token, [["GET", "/api/overview"]], "uptime:read");
    await expectRefused(token, [["GET", "/api/settings"]], "settings:read");
    await expectRefused(token, [["POST", "/api/incidents/inc_x/updates", { status: "resolved", message: "x" }]], "incidents:edit");
  });

  it("Edit covers testing, rotating and deleting", async () => {
    const { monitorId, active } = await fixtures();
    const token = await scopedToken(["monitors:edit", "maintenance:edit"]);
    expect((await call(`/api/monitors/${monitorId}/test`, { method: "POST", headers: asBearer(token) })).status).not.toBe(403);
    const rotated = await call(`/api/monitors/${monitorId}/rotate-heartbeat-token`, { method: "POST", headers: asBearer(token) });
    expect(rotated.status).not.toBe(403);
    expect((await call(`/api/maintenance/${active}`, { method: "DELETE", headers: asBearer(token) })).status).toBe(200);
    expect((await call(`/api/monitors/${monitorId}`, { method: "DELETE", headers: asBearer(token) })).status).toBe(200);
  });

  it("refuse an unknown permission when creating", async () => {
    const res = await call("/api/api-tokens", { json: { name: "Bad", scopes: ["monitors:fly"] }, headers: asSession(await signIn()) });
    expect(res.status).toBe(400);
  });

  it("keep a stored token with the older scope words working, mapped to read and edit", async () => {
    // A row as the #121 code wrote it.
    const token = `opk_${randomToken(32)}`;
    await env.DB.prepare(
      "INSERT INTO api_tokens (id, name, token_hash, prefix, scopes, created_at) VALUES ('tok_v121', 'Old sync', ?, ?, 'read monitors:write', ?)",
    )
      .bind(`v2:${await sha256hex(token)}`, token.slice(0, 8), Date.now())
      .run();
    const self = await (await call("/api/api-tokens/self", { headers: asBearer(token) })).json<{ scopes: string[] }>();
    expect(self.scopes).toEqual([
      "monitors:read",
      "monitors:edit",
      "uptime:read",
      "categories:read",
      "incidents:read",
      "maintenance:read",
      "status_pages:read",
      "channels:read",
      "reports:read",
      "diagnostics:read",
    ]);
    const { monitorId } = await fixtures();
    await expectAllowed(token, [["POST", `/api/monitors/${monitorId}/pause`]]);
    await expectRefused(token, [["GET", "/api/data/export"]], "backups:read");
  });

  it("legacy read sees monitoring data but nothing private, and changes nothing", async () => {
    const { monitorId } = await fixtures();
    const token = await scopedToken(["read"]);
    await expectAllowed(token, [
      ["GET", "/api/overview"],
      ["GET", "/api/monitors"],
      ["GET", `/api/monitors/${monitorId}`],
      ["GET", "/api/monitors/uptime"],
      ["GET", "/api/incidents"],
      ["GET", "/api/reports/monthly?month=2026-01"],
      ["GET", "/api/diagnostics"],
      ["GET", "/api/maintenance"],
      ["GET", "/api/status-pages"],
      ["GET", "/api/categories"],
      ["GET", "/api/channels"],
    ]);
    await expectRefused(token, [["GET", "/api/settings"]], "settings:read");
    await expectRefused(token, [["GET", "/api/data/export"]], "backups:read");
    await expectRefused(token, [["GET", "/api/admin/rekey/status"]], "encryption:read");
    await expectRefused(token, [["GET", "/api/waitlist"]], "site:read");
    await expectRefused(token, [["GET", "/api/passkeys"]], "security:read");
    await expectRefused(token, [["POST", `/api/monitors/${monitorId}/pause`]], "monitors:edit");
    await expectRefused(token, [["POST", "/api/maintenance", { title: "x" }]], "maintenance:edit");
    await expectRefused(token, [["POST", "/api/incidents/inc_x/updates", { status: "resolved", message: "x" }]], "incidents:edit");
  });

  it("legacy monitors:write is monitors read and edit, so it now also deletes and rotates", async () => {
    const { monitorId } = await fixtures();
    const token = await scopedToken(["monitors:write"]);
    const created = await call("/api/monitors", {
      json: { type: "heartbeat", name: "Agent made", config: { intervalSeconds: 3600, graceSeconds: 300 } },
      headers: asBearer(token),
    });
    expect(created.status).toBe(201);
    await expectAllowed(token, [
      ["PATCH", `/api/monitors/${monitorId}`, { name: "Renamed by agent" }],
      ["POST", `/api/monitors/${monitorId}/pause`],
      ["POST", `/api/monitors/${monitorId}/resume`],
    ]);
    // It now includes read of monitors (edit implies read), but not of anything else.
    await expectAllowed(token, [["GET", "/api/monitors"]]);
    await expectRefused(token, [["GET", "/api/incidents"]], "incidents:read");
    expect((await call(`/api/monitors/${monitorId}`, { method: "DELETE", headers: asBearer(token) })).status).toBe(200);
  });

  it("legacy incidents:write posts updates; maintenance:write opens, ends and deletes windows", async () => {
    const { upcoming, active } = await fixtures();
    const incidents = await scopedToken(["incidents:write"]);
    // The incident does not exist (404), but the scope let the call through.
    const posted = await call("/api/incidents/inc_missing/updates", {
      json: { status: "resolved", message: "Fixed" },
      headers: asBearer(incidents),
    });
    expect(posted.status).toBe(404);
    await expectRefused(incidents, [["POST", "/api/maintenance", {}]], "maintenance:edit");

    const maint = await scopedToken(["maintenance:write"]);
    const opened = await call("/api/maintenance", {
      json: { title: "Deploy", scope: "global", startsAt: Date.now(), endsAt: Date.now() + 600_000 },
      headers: asBearer(maint),
    });
    expect(opened.status).toBe(201);
    const openedId = (await opened.json<{ window: { id: string } }>()).window.id;
    expect((await call(`/api/maintenance/${openedId}/end`, { method: "POST", headers: asBearer(maint) })).status).toBe(200);
    expect((await call(`/api/maintenance/${upcoming}`, { method: "DELETE", headers: asBearer(maint) })).status).toBe(200);
    await expectRefused(maint, [["POST", "/api/incidents/inc_x/updates", {}]], "incidents:edit");
    // Edit includes deleting a window that has started.
    expect((await call(`/api/maintenance/${active}`, { method: "DELETE", headers: asBearer(maint) })).status).toBe(200);
  });

  it("refuse a route missing from the scope table unless the token is admin (default deny)", async () => {
    const app = new Hono<AppEnv>();
    app.use("/api/*", requireAuth);
    app.get("/api/brand-new-feature", (c) => c.json({ ok: true }));
    const get = (token: string) =>
      app.fetch(new Request(`${ORIGIN}/api/brand-new-feature`, { headers: asBearer(token) }), env as Env);

    const everythingButAdmin = await scopedToken([...PERMISSIONS]);
    const refused = await get(everythingButAdmin);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "insufficient_scope", required: "admin" });
    expect((await get(await scopedToken(["admin"]))).status).toBe(200);
    expect((await get(SECRET)).status).toBe(200);
  });

  it("stop working when they expire", async () => {
    const before = Date.now();
    const owner = await signIn();
    const res = await call("/api/api-tokens", {
      json: { name: "Week", scopes: ["read"], expiresInDays: 7 },
      headers: asSession(owner),
    });
    const { token, apiToken } = await res.json<{ token: string; apiToken: { id: string; expiresAt: number } }>();
    expect(apiToken.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(apiToken.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    expect((await call("/api/overview", { headers: asBearer(token) })).status).toBe(200);

    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, apiToken.id).run();
    expect((await call("/api/overview", { headers: asBearer(token) })).status).toBe(401);
    expect((await mcpInitialize(token)).status).toBe(401);
    // Expired tokens stay listed (marked by their expiresAt) until revoked.
    const list = await (await call("/api/api-tokens", { headers: { cookie: owner.cookie } })).json<{ tokens: { id: string }[] }>();
    expect(list.tokens.some((t) => t.id === apiToken.id)).toBe(true);
  });

  it("keep tokens from before scopes existed working as admin", async () => {
    // A row exactly as migration 0017 code wrote it: bare hex hash, no scopes.
    const token = `opk_${randomToken(32)}`;
    await env.DB.prepare(
      "INSERT INTO api_tokens (id, name, token_hash, prefix, created_at, last_used_at) VALUES (?, 'Legacy', ?, ?, ?, NULL)",
    )
      .bind("tok_legacy", await sha256hex(token), token.slice(0, 8), Date.now())
      .run();
    const row = await env.DB.prepare("SELECT scopes, expires_at FROM api_tokens WHERE id = 'tok_legacy'").first();
    expect(row).toEqual({ scopes: "admin", expires_at: null });
    expect((await call("/api/settings", { headers: asBearer(token) })).status).toBe(200);
    expect((await call("/api/monitors/mon_missing", { method: "DELETE", headers: asBearer(token) })).status).toBe(404);
    expect(await (await call("/api/api-tokens/self", { headers: asBearer(token) })).json()).toMatchObject({
      name: "Legacy",
      scopes: ["admin"],
    });
    // ...and it still can't manage tokens.
    expect((await call("/api/api-tokens", { json: { name: "x" }, headers: asBearer(token) })).status).toBe(403);
  });

  it("are rate limited per token", async () => {
    const { token: busy, id } = await createToken(await signIn(), "Busy agent", { scopes: ["read"] });
    const other = await scopedToken(["read"]);
    expect((await call("/api/api-tokens/self", { headers: asBearer(busy) })).status).toBe(200);
    // Spend the rest of this minute's allowance (and the next minute's, so a
    // window rolling over mid-test changes nothing) without 120 round trips.
    const minute = Math.floor(Date.now() / 60_000);
    for (const w of [minute, minute + 1]) {
      await env.DB.prepare(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count",
      )
        .bind(`api:api-token:${id}:${w}`, w * 60_000, API_TOKEN_RATE_LIMIT_PER_MINUTE)
        .run();
    }
    const limited = await call("/api/overview", { headers: asBearer(busy) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await limited.json<{ error: string }>()).error).toBe("rate_limited");
    // Each token has its own allowance.
    expect((await call("/api/api-tokens/self", { headers: asBearer(other) })).status).toBe(200);
  });
});

async function mcpRpc(token: string, method: string, params?: unknown) {
  const res = await call("/mcp", {
    json: { jsonrpc: "2.0", id: 7, method, ...(params ? { params } : {}) },
    headers: { ...asBearer(token), accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  });
  expect(res.status).toBe(200);
  return res.json<{
    result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
    error?: { message: string };
  }>();
}

describe("scoped tokens over MCP", () => {
  it("list only the tools the token's scopes allow", async () => {
    const listed = async (scopes: string[]) =>
      ((await mcpRpc(await scopedToken(scopes), "tools/list")).result?.tools ?? []).map((t) => t.name).sort();
    const forScopes = (scopes: string[]) =>
      Object.entries(TOOL_SCOPES)
        .filter(([, s]) => normalizeScopes(scopes).includes(s))
        .map(([name]) => name)
        .sort();

    expect(await listed(["read"])).toEqual(forScopes(["read"]));
    expect(await listed(["read"])).not.toContain("delete_monitor");
    expect(await listed(["read", "monitors:write"])).toEqual(forScopes(["read", "monitors:write"]));
    expect(await listed(["monitors:edit"])).toEqual([
      "create_monitor",
      "delete_monitor",
      "get_monitor",
      "list_monitors",
      "pause_monitor",
      "resume_monitor",
      "rotate_heartbeat_token",
      "update_monitor",
    ]);
    expect(await listed(["maintenance:edit"])).toEqual([
      "create_maintenance_window",
      "delete_maintenance_window",
      "end_maintenance_window",
      "list_maintenance",
    ]);
    expect(await listed(["admin"])).toEqual(Object.keys(TOOL_SCOPES).sort());
  });

  it("refuse a call to a tool outside the token's scopes, and keep the confirm rule", async () => {
    const read = await scopedToken(["read"]);
    const refused = await mcpRpc(read, "tools/call", {
      name: "create_monitor",
      arguments: { type: "heartbeat", name: "Nope", config: { intervalSeconds: 3600 } },
    });
    expect(refused.result?.isError ?? !!refused.error).toBe(true);
    expect(JSON.stringify(refused)).toMatch(/create_monitor/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE name = 'Nope'").first<{ n: number }>())?.n).toBe(0);

    const { upcoming, active } = await fixtures();
    const maint = await scopedToken(["maintenance:write"]);
    const unconfirmed = await mcpRpc(maint, "tools/call", { name: "delete_maintenance_window", arguments: { id: upcoming } });
    expect(unconfirmed.result?.isError).toBe(true);
    expect(unconfirmed.result?.content?.[0]?.text).toContain("confirm: true");
    const started = await mcpRpc(maint, "tools/call", {
      name: "delete_maintenance_window",
      arguments: { id: active, confirm: true },
    });
    // Edit includes deleting a window that has started.
    expect(started.result?.isError).toBeFalsy();
    const cancelled = await mcpRpc(maint, "tools/call", {
      name: "delete_maintenance_window",
      arguments: { id: upcoming, confirm: true },
    });
    expect(cancelled.result?.isError).toBeFalsy();
  });
});
