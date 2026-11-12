import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { runFirstCheck } from "../../src/worker/checks/first-check";
import { getMonitor } from "../../src/worker/db/monitors";
import { DEFAULT_CHECKER_USER_AGENT } from "../../src/worker/lib/user-agent";

/**
 * The checker names itself on every request (lib/user-agent.ts), and /bot
 * explains it. On 2026-11-11 a Cloudflare custom rule challenging requests
 * with no User-Agent turned every HTTP monitor on that zone into a 403.
 */

const ORIGIN = "https://openping.test";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

/** Spy on outbound fetches, answering 200, and collect each request's User-Agent by URL. */
function recordAgents() {
  const seen: { url: string; userAgent: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, userAgent: request.headers.get("user-agent") });
    return new Response("ok", { status: 200 });
  });
  return seen;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => vi.restoreAllMocks());

describe("the checker's User-Agent", () => {
  it("is sent by a new monitor's first check and by a manual test", async () => {
    const seen = recordAgents();
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({ type: "http", name: "Named check", config: { url: "https://named.example.com/" } }),
    });
    expect(res.status).toBe(201);
    const { monitor } = await res.json<{ monitor: { id: string } }>();

    const test = await apiRequest(`/api/monitors/${monitor.id}/test`, { method: "POST" });
    expect(test.status).toBe(200);

    const toSite = seen.filter((s) => s.url.startsWith("https://named.example.com/"));
    // The first check, the manual test, and possibly the background icon fetch.
    expect(toSite.length).toBeGreaterThanOrEqual(2);
    for (const s of toSite) expect(s.userAgent).toBe(DEFAULT_CHECKER_USER_AGENT);
  });

  it("is the install's CHECKER_USER_AGENT when one is set", async () => {
    const seen = recordAgents();
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({ type: "http", name: "Custom agent", config: { url: "https://custom-agent.example.com/" } }),
    });
    const { monitor } = await res.json<{ monitor: { id: string } }>();
    seen.length = 0;

    const record = await getMonitor(env, monitor.id);
    await runFirstCheck({ ...env, CHECKER_USER_AGENT: "AcmeUptime/1.0 (+https://status.acme.test/bot)" }, record!);

    expect(seen.map((s) => s.userAgent)).toEqual(["AcmeUptime/1.0 (+https://status.acme.test/bot)"]);
  });
});

describe("GET /bot", () => {
  it("explains the checker in a public page, showing this install's User-Agent", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/bot`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("<title>The OpenPing checker | OpenPing</title>");
    expect(html).toContain(`<code>${DEFAULT_CHECKER_USER_AGENT}</code>`);
    expect(html).toContain("User-Agent starts with OpenPing/");
    expect(html).not.toContain("<script");
  });
});
