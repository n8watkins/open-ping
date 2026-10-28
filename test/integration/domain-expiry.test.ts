import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import type { DomainCache } from "../../src/worker/checks/domain";
import { countingD1 } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// Domain expiry against D1 (docs/MONITOR_TYPES.md, "Domain expiry"): the last
// RDAP read is cached on monitor_state, most cycles are judged from it with no
// request, and a failed refresh (a rate limit, an RDAP outage) is judged from
// the cache instead of taking the monitor down.

const API_ORIGIN = "https://openping.test";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };
const FAST = { confirmDelayMs: 1, rdapSpacingMs: 0 };

const rdapUrl = (domain: string) => `https://rdap.org/domain/${domain}`;

/** An RDAP answer whose expiration is `days` from now. */
function expiring(days: number): Response {
  const eventDate = new Date(Date.now() + days * DAY_MS).toISOString();
  return new Response(JSON.stringify({ events: [{ eventAction: "expiration", eventDate }] }), {
    status: 200,
    headers: { "content-type": "application/rdap+json" },
  });
}

/**
 * Stub RDAP: each request answers with the next response in the script (the
 * last one repeats). Any other URL fails the test. Returns the URLs requested.
 */
function stubRdap(domain: string, script: (() => Response)[]): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== rdapUrl(domain)) throw new Error(`unexpected outbound request: ${url}`);
    const next = script[Math.min(calls.length, script.length - 1)]!;
    calls.push(url);
    return next();
  });
  return calls;
}

const rateLimited = () => new Response("error code: 1015", { status: 429, headers: { "retry-after": "60" } });
const unavailable = () => new Response("unavailable", { status: 503 });

async function createDomainMonitor(name: string, domain: string): Promise<string> {
  const calls = stubRdap(domain, [() => expiring(200)]);
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ type: "domain", name, config: { domain } }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ monitor: { id: string }; firstCheck: { status: string; state: string } }>();
  // The first check (#31) looks the domain up right away.
  expect(calls).toHaveLength(1);
  expect(body.firstCheck).toMatchObject({ status: "checked", state: "up" });
  vi.restoreAllMocks();
  return body.monitor.id;
}

/** Make only this monitor due, as an up monitor whose interval passed. */
async function dueAndUp(id: string): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + HOUR_MS).run();
  await env.DB.prepare(
    "UPDATE monitor_state SET state = 'up', next_check_at = 0, active_incident_id = NULL WHERE monitor_id = ?",
  )
    .bind(id)
    .run();
}

async function cacheOf(id: string): Promise<DomainCache | null> {
  const row = await env.DB.prepare("SELECT domain_cache FROM monitor_state WHERE monitor_id = ?")
    .bind(id)
    .first<{ domain_cache: string | null }>();
  return row?.domain_cache ? (JSON.parse(row.domain_cache) as DomainCache) : null;
}

async function setCache(id: string, cache: DomainCache | null): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET domain_cache = ? WHERE monitor_id = ?")
    .bind(cache ? JSON.stringify(cache) : null, id)
    .run();
}

/** Make the stored read `ageMs` old. */
async function ageCache(id: string, ageMs: number): Promise<DomainCache> {
  const cache = (await cacheOf(id))!;
  const aged = { ...cache, checkedAt: Date.now() - ageMs };
  await setCache(id, aged);
  return aged;
}

async function stateOf(id: string) {
  return env.DB.prepare(
    "SELECT state, next_check_at, active_incident_id, last_error FROM monitor_state WHERE monitor_id = ?",
  )
    .bind(id)
    .first<{ state: string; next_check_at: number; active_incident_id: string | null; last_error: string | null }>();
}

async function latestSample(id: string) {
  const row = await env.DB.prepare(
    "SELECT ok, state, error, duration_ms, attempts, meta FROM samples WHERE monitor_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
  )
    .bind(id)
    .first<{ ok: number; state: string; error: string | null; duration_ms: number | null; attempts: number; meta: string | null }>();
  return row ? { ...row, meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null } : null;
}

async function openIncidents(id: string) {
  const res = await env.DB.prepare("SELECT id, confirmed FROM incidents WHERE monitor_id = ? AND status = 'open'")
    .bind(id)
    .all<{ id: string; confirmed: number }>();
  return res.results ?? [];
}

async function outboxCount(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function latestRun() {
  return env.DB.prepare(
    `SELECT monitors_checked, confirmations, confirmations_deferred, d1_queries
     FROM scheduler_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).first<{ monitors_checked: number; confirmations: number; confirmations_deferred: number; d1_queries: number }>();
}

/** One cron run, counting its D1 queries from outside the scheduler. */
async function run(): Promise<number> {
  const usage = { d1: 0 };
  await runScheduled(controller, { ...env, DB: countingD1(env.DB, usage) }, FAST);
  return usage.d1;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

describe("domain expiry cache", () => {
  it("the first check stores the read, and a fresh read is judged with no request and no extra queries", async () => {
    const domain = "cached.dev";
    const id = await createDomainMonitor("Cached", domain);
    const stored = await cacheOf(id);
    expect(stored).toMatchObject({ domain });
    expect(stored!.expiresAt).toBeGreaterThan(Date.now() + 199 * DAY_MS);

    // A refreshing run, for its D1 count.
    await ageCache(id, 7 * HOUR_MS);
    await dueAndUp(id);
    let calls = stubRdap(domain, [() => expiring(200)]);
    const refreshD1 = await run();
    expect(calls).toHaveLength(1);
    vi.restoreAllMocks();

    // Now the read is fresh: no request at all.
    await dueAndUp(id);
    calls = stubRdap(domain, [() => expiring(200)]);
    const cachedD1 = await run();
    expect(calls).toHaveLength(0);
    expect(await stateOf(id)).toMatchObject({ state: "up", active_incident_id: null });
    const sample = await latestSample(id);
    expect(sample).toMatchObject({ ok: 1, state: "up", duration_ms: null });
    expect(sample!.meta).toMatchObject({ source: "cache", daysUntil: 199 });
    expect(await latestRun()).toMatchObject({ monitors_checked: 1, d1_queries: cachedD1 });
    // The cache rides on the state row the run already reads and writes.
    expect(cachedD1).toBe(refreshD1);
  });

  it("refreshes a read older than six hours and stores the new date", async () => {
    const domain = "stale.dev";
    const id = await createDomainMonitor("Stale", domain);
    const aged = await ageCache(id, 7 * HOUR_MS);
    await dueAndUp(id);
    const calls = stubRdap(domain, [() => expiring(400)]);

    await run();

    expect(calls).toEqual([rdapUrl(domain)]);
    const cache = (await cacheOf(id))!;
    expect(cache.checkedAt).toBeGreaterThan(aged.checkedAt);
    expect(cache.expiresAt).toBeGreaterThan(Date.now() + 399 * DAY_MS);
    expect(cache.lastError).toBeUndefined();
    expect((await latestSample(id))!.meta).toMatchObject({ source: "rdap", daysUntil: 400 });
  });

  it("a rate-limited refresh with a recent read stays up, opens no incident and makes no second request", async () => {
    const domain = "limited.dev";
    const id = await createDomainMonitor("Limited", domain);
    const aged = await ageCache(id, 7 * HOUR_MS);
    await dueAndUp(id);
    let calls = stubRdap(domain, [rateLimited]);

    await run();

    expect(calls).toHaveLength(1);
    expect(await stateOf(id)).toMatchObject({ state: "up", active_incident_id: null, last_error: null });
    expect(await openIncidents(id)).toHaveLength(0);
    expect(await outboxCount(id)).toBe(0);
    const sample = await latestSample(id);
    expect(sample).toMatchObject({ ok: 1, state: "up", attempts: 1 });
    expect(sample!.meta).toMatchObject({
      source: "cache",
      checkedAt: aged.checkedAt,
      lookupError: { code: "rdap_rate_limited" },
    });
    // The read is kept, with when to try again (at least an hour; Retry-After was 60 s).
    const cache = (await cacheOf(id))!;
    expect(cache).toMatchObject({ expiresAt: aged.expiresAt, checkedAt: aged.checkedAt });
    expect(cache.retryAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    vi.restoreAllMocks();

    // The monitor page gets the latest sample's meta, to show the failed lookup.
    const detail = await (await apiRequest(`/api/monitors/${id}/detail`)).json<{
      recentSamples: { meta?: Record<string, unknown> }[];
    }>();
    expect(detail.recentSamples.at(-1)?.meta).toMatchObject({ lookupError: { code: "rdap_rate_limited" } });
    expect(detail.recentSamples.slice(0, -1).every((s) => s.meta === undefined)).toBe(true);

    // The next run holds off: no request, still up, still showing the failed lookup.
    await dueAndUp(id);
    calls = stubRdap(domain, [rateLimited]);
    await run();
    expect(calls).toHaveLength(0);
    expect(await stateOf(id)).toMatchObject({ state: "up" });
    expect((await latestSample(id))!.meta).toMatchObject({ lookupError: { code: "rdap_rate_limited" } });
  });

  it("with no usable read, a failed lookup is confirmed and opens an incident as before", async () => {
    const domain = "nocache.dev";
    const id = await createDomainMonitor("No cache", domain);
    // Older than the 7-day limit: not trusted any more.
    await ageCache(id, 8 * DAY_MS);
    await dueAndUp(id);
    const calls = stubRdap(domain, [unavailable]);

    await run();

    expect(calls).toHaveLength(2);
    expect(await stateOf(id)).toMatchObject({ state: "down", last_error: "rdap_error" });
    expect(await openIncidents(id)).toEqual([expect.objectContaining({ confirmed: 1 })]);
    expect(await latestRun()).toMatchObject({ confirmations: 1 });
  });

  it("with no usable read, a 429 makes no second request and waits for the next run instead of alerting", async () => {
    const domain = "nocache-limited.dev";
    const id = await createDomainMonitor("No cache limited", domain);
    await setCache(id, null);
    await dueAndUp(id);
    const calls = stubRdap(domain, [rateLimited]);

    await run();

    expect(calls).toHaveLength(1);
    expect(await stateOf(id)).toMatchObject({ state: "up", next_check_at: 0, active_incident_id: null });
    expect(await openIncidents(id)).toHaveLength(0);
    expect(await latestRun()).toMatchObject({ monitors_checked: 0, confirmations_deferred: 1 });
  });

  it("an expired date is down at once, from a single lookup", async () => {
    const domain = "expired.dev";
    const id = await createDomainMonitor("Expired", domain);
    await ageCache(id, 7 * HOUR_MS);
    await dueAndUp(id);
    const calls = stubRdap(domain, [() => expiring(-2)]);

    await run();

    expect(calls).toHaveLength(1);
    expect(await stateOf(id)).toMatchObject({ state: "down", last_error: "domain_expired" });
    expect(await openIncidents(id)).toHaveLength(1);
    expect((await cacheOf(id))!.expiresAt).toBeLessThan(Date.now());
  });

  it("looks up again when the monitor's domain changes", async () => {
    const domain = "renamed.dev";
    const id = await createDomainMonitor("Renamed", domain);
    // A fresh read, but of the old domain.
    await setCache(id, { ...(await cacheOf(id))!, domain: "old-name.dev" });
    await dueAndUp(id);
    const calls = stubRdap(domain, [() => expiring(90)]);

    await run();

    expect(calls).toHaveLength(1);
    expect(await cacheOf(id)).toMatchObject({ domain });
  });

  it("a manual test asks RDAP even with a fresh read", async () => {
    const domain = "manual.dev";
    const id = await createDomainMonitor("Manual", domain);
    const calls = stubRdap(domain, [() => expiring(150)]);
    const res = await apiRequest(`/api/monitors/${id}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json<{ outcome: { state: string; meta: Record<string, unknown> }; applied: boolean }>();
    expect(calls).toHaveLength(1);
    expect(body.outcome).toMatchObject({ state: "up", meta: { source: "rdap", daysUntil: 150 } });
  });
});
