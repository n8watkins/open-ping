import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { tlsReader, type CertCache } from "../../src/worker/checks/cert";
import type { CertificateInfo, TlsReadResult } from "../../src/worker/checks/tls";
import { countingD1 } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// SSL certificate monitors against D1 (docs/MONITOR_TYPES.md, "SSL
// certificate"), with a fake TLS reader standing in for the socket: the read is
// cached on monitor_state, most cycles are judged from it with no connection,
// each warning threshold alerts once, an expired certificate opens an incident
// like an expired domain, and a certificate that can't be read from a Worker
// (behind Cloudflare, TLS 1.3 only) is never down and never alerts.

const API_ORIGIN = "https://openping.test";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HOST = "shop.example.com";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };
const FAST = { confirmDelayMs: 1, rdapSpacingMs: 0 };

const cert = (days: number, over: Partial<CertificateInfo> = {}): CertificateInfo => ({
  subject: HOST,
  issuerOrg: "Let's Encrypt",
  issuerName: "R11",
  validFrom: Date.now() - 30 * DAY_MS,
  // A little over `days` whole days left.
  validTo: Date.now() + days * DAY_MS + HOUR_MS,
  sans: [HOST, `www.${HOST}`],
  sanCount: 2,
  serial: "04aa",
  ...over,
});
const served = (c: CertificateInfo): TlsReadResult => ({ ok: true, cert: c, chainLength: 2, durationMs: 35 });
const behindCloudflare: TlsReadResult = {
  ok: false,
  kind: "connect_failed",
  message: "proxy request failed, cannot connect to the specified address",
  durationMs: 3,
};
const tls13Only: TlsReadResult = {
  ok: false,
  kind: "alert",
  alert: 70,
  message: "the server refused the TLS 1.2 handshake (alert 70, protocol_version)",
  durationMs: 20,
};
const timedOut: TlsReadResult = { ok: false, kind: "timeout", message: "no certificate within 10000ms", durationMs: 10000 };

/** The fake TLS reader: each read answers with the next result (the last repeats). Returns the hosts read. */
function fakeTls(...script: TlsReadResult[]): string[] {
  const reads: string[] = [];
  vi.spyOn(tlsReader, "read").mockImplementation(async (host, port) => {
    reads.push(`${host}:${port}`);
    return script[Math.min(reads.length - 1, script.length - 1)]!;
  });
  return reads;
}

async function createCertMonitor(name: string, first: TlsReadResult, config: Record<string, unknown> = {}) {
  const reads = fakeTls(first);
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ type: "cert", name, config: { host: HOST, ...config } }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ monitor: { id: string; config: { warnDays: number[] } }; firstCheck: { status: string; state: string } }>();
  // The first check (#31) reads the certificate right away.
  expect(reads).toEqual([`${HOST}:${(config.port as number | undefined) ?? 443}`]);
  vi.restoreAllMocks();
  return body;
}

/** Make only this monitor due, as a monitor in `state` whose interval passed. */
async function due(id: string, state = "up"): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + HOUR_MS).run();
  await env.DB.prepare("UPDATE monitor_state SET state = ?, next_check_at = 0 WHERE monitor_id = ?")
    .bind(state, id)
    .run();
}

async function cacheOf(id: string): Promise<CertCache | null> {
  const row = await env.DB.prepare("SELECT cert_cache FROM monitor_state WHERE monitor_id = ?")
    .bind(id)
    .first<{ cert_cache: string | null }>();
  return row?.cert_cache ? (JSON.parse(row.cert_cache) as CertCache) : null;
}

async function setCache(id: string, cache: CertCache): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET cert_cache = ? WHERE monitor_id = ?").bind(JSON.stringify(cache), id).run();
}

async function stateOf(id: string) {
  return env.DB.prepare("SELECT state, active_incident_id, last_error FROM monitor_state WHERE monitor_id = ?")
    .bind(id)
    .first<{ state: string; active_incident_id: string | null; last_error: string | null }>();
}

async function latestSample(id: string) {
  const row = await env.DB.prepare(
    "SELECT ok, state, error, duration_ms, meta FROM samples WHERE monitor_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
  )
    .bind(id)
    .first<{ ok: number; state: string; error: string | null; duration_ms: number | null; meta: string | null }>();
  return row ? { ...row, meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null } : null;
}

async function outbox(id: string) {
  const res = await env.DB.prepare("SELECT event_type, event_key FROM notification_outbox WHERE monitor_id = ? ORDER BY created_at, rowid")
    .bind(id)
    .all<{ event_type: string; event_key: string }>();
  return res.results ?? [];
}

async function incidents(id: string) {
  const res = await env.DB.prepare("SELECT status FROM incidents WHERE monitor_id = ? ORDER BY started_at")
    .bind(id)
    .all<{ status: string }>();
  return (res.results ?? []).map((r) => r.status);
}

async function downSeconds(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(down_seconds), 0) AS s, COUNT(*) AS n FROM summaries WHERE monitor_id = ?")
    .bind(id)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

async function run(): Promise<number> {
  const usage = { d1: 0 };
  await runScheduled(controller, { ...env, DB: countingD1(env.DB, usage) }, FAST);
  return usage.d1;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM monitors"), env.DB.prepare("DELETE FROM notification_channels")]);
  const res = await apiRequest("/api/channels", {
    method: "POST",
    body: JSON.stringify({ type: "webhook", name: "Hook", config: { url: "https://hooks.example.com/cert" } }),
  });
  expect(res.status).toBe(201);
});
afterEach(() => vi.restoreAllMocks());

describe("SSL certificate monitor", () => {
  it("reads the certificate on create, then judges cycles from the cache with no connection", async () => {
    const { monitor, firstCheck } = await createCertMonitor("Shop", served(cert(60)));
    expect(firstCheck).toMatchObject({ status: "checked", state: "up" });
    expect(monitor.config.warnDays).toEqual([30, 14, 7]);
    expect(await cacheOf(monitor.id)).toMatchObject({ host: HOST, port: 443, read: { kind: "cert" } });

    await due(monitor.id);
    const reads = fakeTls(served(cert(60)));
    await run();
    expect(reads).toEqual([]);
    const sample = await latestSample(monitor.id);
    expect(sample).toMatchObject({ ok: 1, state: "up", duration_ms: null });
    expect(sample!.meta).toMatchObject({ source: "cache", daysUntil: 60, issuer: "Let's Encrypt (R11)", host: HOST });

    // The monitor page shows the full read, names included.
    const detail = await (await apiRequest(`/api/monitors/${monitor.id}/detail`)).json<{ certificate: unknown; state: unknown }>();
    expect(detail.certificate).toMatchObject({
      host: HOST,
      certificate: { issuer: "Let's Encrypt (R11)", daysUntil: 60, sans: [HOST, `www.${HOST}`], coversHost: true },
    });
    expect(detail.state).not.toHaveProperty("cert_cache");
  });

  it("reads again once a day, and the manual test always reads", async () => {
    const { monitor } = await createCertMonitor("Daily", served(cert(60)));
    const cache = (await cacheOf(monitor.id))!;
    await setCache(monitor.id, { ...cache, checkedAt: Date.now() - 25 * HOUR_MS });
    await due(monitor.id);
    let reads = fakeTls(served(cert(90)));
    await run();
    expect(reads).toHaveLength(1);
    expect((await latestSample(monitor.id))!.meta).toMatchObject({ source: "tls", daysUntil: 90 });
    vi.restoreAllMocks();

    reads = fakeTls(served(cert(91)));
    const test = await apiRequest(`/api/monitors/${monitor.id}/test`, { method: "POST" });
    expect(reads).toHaveLength(1);
    expect(await test.json()).toMatchObject({ applied: false, outcome: { state: "up", meta: { daysUntil: 91 } } });
  });

  it("alerts each warning threshold once, and starts over for a renewed certificate", async () => {
    const { monitor } = await createCertMonitor("Warn", served(cert(60)));
    expect(await outbox(monitor.id)).toEqual([]);

    // 20 days left: degraded, and the 30-day threshold alerts.
    const c20 = cert(20);
    await setCache(monitor.id, { host: HOST, port: 443, checkedAt: Date.now() - 60_000, read: { kind: "cert", cert: c20, chainLength: 2 } });
    await due(monitor.id);
    fakeTls(served(c20));
    await run();
    expect(await stateOf(monitor.id)).toMatchObject({ state: "degraded", active_incident_id: null });
    expect((await outbox(monitor.id)).map((o) => o.event_type)).toEqual(["cert_expiring"]);
    expect((await cacheOf(monitor.id))!.warned).toEqual({ validTo: c20.validTo, days: 30 });

    // Still 20 days: no second alert.
    await due(monitor.id, "degraded");
    await run();
    expect(await outbox(monitor.id)).toHaveLength(1);

    // 13 days: the 14-day threshold.
    const c13 = { ...c20, validTo: Date.now() + 13 * DAY_MS + HOUR_MS };
    await setCache(monitor.id, {
      ...(await cacheOf(monitor.id))!,
      read: { kind: "cert", cert: c13, chainLength: 2 },
      warned: { validTo: c13.validTo, days: 30 },
    });
    await due(monitor.id, "degraded");
    await run();
    const keys = (await outbox(monitor.id)).map((o) => o.event_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toContain(`:${c13.validTo}:14:`);
    expect(await incidents(monitor.id)).toEqual([]);

    // Renewed (90 days, read an hour later since it's in the window): up, no alert.
    const cache = (await cacheOf(monitor.id))!;
    await setCache(monitor.id, { ...cache, checkedAt: Date.now() - HOUR_MS - 1 });
    await due(monitor.id, "degraded");
    fakeTls(served(cert(90)));
    await run();
    expect(await stateOf(monitor.id)).toMatchObject({ state: "up" });
    expect((await cacheOf(monitor.id))!.warned).toBeUndefined();
    expect(await outbox(monitor.id)).toHaveLength(2);
  });

  it("opens an incident for an expired certificate, like an expired domain, and resolves it on renewal", async () => {
    const { monitor } = await createCertMonitor("Expired", served(cert(60)));
    const expired = cert(-3);
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - 25 * HOUR_MS });
    await due(monitor.id);
    const reads = fakeTls(served(expired));
    await run();
    // A date the server sent isn't re-checked.
    expect(reads).toHaveLength(1);
    expect(await stateOf(monitor.id)).toMatchObject({ state: "down", last_error: "cert_expired" });
    expect(await incidents(monitor.id)).toEqual(["open"]);
    expect((await outbox(monitor.id)).map((o) => o.event_type)).toEqual(["down"]);
    vi.restoreAllMocks();

    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - HOUR_MS - 1 });
    await due(monitor.id, "down");
    fakeTls(served(cert(89)));
    await run();
    expect(await stateOf(monitor.id)).toMatchObject({ state: "up", active_incident_id: null });
    expect(await incidents(monitor.id)).toEqual(["resolved"]);
    expect((await outbox(monitor.id)).map((o) => o.event_type)).toEqual(["down", "recovered"]);
  });

  it("is can't check, never down, for a host behind Cloudflare: no incident, no alert, no downtime", async () => {
    const { monitor, firstCheck } = await createCertMonitor("Render app", behindCloudflare);
    expect(firstCheck).toMatchObject({ status: "checked", state: "cant_check" });
    await due(monitor.id, "cant_check");
    const reads = fakeTls(behindCloudflare);
    await run();
    // Read once a day, so this cycle is judged from the cache.
    expect(reads).toEqual([]);
    expect(await stateOf(monitor.id)).toMatchObject({ state: "cant_check", active_incident_id: null, last_error: null });
    const sample = await latestSample(monitor.id);
    expect(sample).toMatchObject({ ok: 1, state: "cant_check" });
    expect(sample!.meta).toMatchObject({ cantCheck: { reason: "cloudflare", message: expect.stringContaining("behind Cloudflare") } });
    expect(await outbox(monitor.id)).toEqual([]);
    expect(await incidents(monitor.id)).toEqual([]);
    expect(await downSeconds(monitor.id)).toBe(0);

    const detail = await (await apiRequest(`/api/monitors/${monitor.id}/detail`)).json<{ certificate: unknown }>();
    expect(detail.certificate).toMatchObject({ cantCheck: { reason: "cloudflare" } });
  });

  it("is can't check for a TLS 1.3-only server", async () => {
    const { firstCheck } = await createCertMonitor("Modern", tls13Only);
    expect(firstCheck).toMatchObject({ status: "checked", state: "cant_check" });
  });

  it("closes an open incident quietly when the host can't be checked any more", async () => {
    const { monitor } = await createCertMonitor("Moved", served(cert(60)));
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - 25 * HOUR_MS });
    await due(monitor.id);
    fakeTls(served(cert(-1)));
    await run();
    expect(await incidents(monitor.id)).toEqual(["open"]);
    vi.restoreAllMocks();

    // The site moved behind Cloudflare and the expired read is an hour old.
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - HOUR_MS - 1 });
    await due(monitor.id, "down");
    fakeTls(behindCloudflare);
    await run();
    expect(await stateOf(monitor.id)).toMatchObject({ state: "cant_check", active_incident_id: null });
    expect(await incidents(monitor.id)).toEqual(["resolved"]);
    // No "recovered" alert: nobody knows whether it recovered.
    expect((await outbox(monitor.id)).map((o) => o.event_type)).toEqual(["down"]);
  });

  it("judges a failed read from a recent one, and fails only with nothing to fall back on", async () => {
    const { monitor } = await createCertMonitor("Flaky", served(cert(60)));
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - 25 * HOUR_MS });
    await due(monitor.id);
    let reads = fakeTls(timedOut);
    await run();
    expect(reads).toHaveLength(1);
    expect(await stateOf(monitor.id)).toMatchObject({ state: "up" });
    expect((await latestSample(monitor.id))!.meta).toMatchObject({ source: "cache", lookupError: { code: "cert_timeout" } });
    expect((await cacheOf(monitor.id))!.retryAt).toBeGreaterThan(Date.now());
    vi.restoreAllMocks();

    // A read older than a week can't stand in: the failure is confirmed and alerts.
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - 8 * DAY_MS, retryAt: 0 });
    await due(monitor.id);
    reads = fakeTls(timedOut);
    await run();
    expect(reads).toHaveLength(2);
    expect(await stateOf(monitor.id)).toMatchObject({ state: "down", last_error: "cert_timeout" });
    expect((await outbox(monitor.id)).map((o) => o.event_type)).toEqual(["down"]);
  });

  it("reads a custom port and thresholds, and spends no D1 query of its own", async () => {
    const { monitor } = await createCertMonitor("Port", served(cert(60)), { port: 8443, warnDays: [7, 45] });
    expect(monitor.config.warnDays).toEqual([45, 7]);
    await due(monitor.id);
    fakeTls(served(cert(60)));
    const cachedD1 = await run();
    await setCache(monitor.id, { ...(await cacheOf(monitor.id))!, checkedAt: Date.now() - 25 * HOUR_MS });
    await due(monitor.id);
    const reads = fakeTls(served(cert(60)));
    const readD1 = await run();
    expect(reads).toEqual([`${HOST}:8443`]);
    // The cache rides on the state row the run already reads and writes.
    expect(readD1).toBe(cachedD1);
  });
});
