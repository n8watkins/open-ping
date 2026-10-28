import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { MAX_REDIRECTS } from "../../src/worker/checks/http";
import { NOTIFICATION_RESERVE, PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// Confirm before alerting, end to end against D1: a failed check re-checks once
// (checks/runner.ts) before the scheduler opens an incident, and the outcome is
// recorded on the incident, the sample and the run.

const API_ORIGIN = "https://openping.test";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = {
  cron: "*/12 * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
};

/**
 * Stub the targets: each URL answers with the next status in its script (the
 * last one repeats). Returns the URLs requested, in order.
 */
function stubTargets(script: Record<string, number[]>): string[] {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const statuses = script[url];
    if (!statuses) throw new Error(`unexpected outbound request: ${url}`);
    const n = seen.get(url) ?? 0;
    seen.set(url, n + 1);
    calls.push(url);
    const status = statuses[Math.min(n, statuses.length - 1)]!;
    return new Response(status < 400 ? "ok" : "unavailable", { status });
  });
  return calls;
}

async function createMonitor(name: string, url: string, extra: Record<string, unknown> = {}): Promise<string> {
  stubTargets({ [url]: [200] });
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ type: "http", name, config: { url }, ...extra }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ monitor: { id: string } }>();
  vi.restoreAllMocks();
  return body.monitor.id;
}

/** Make exactly these monitors due, as if they were up and their 12 minutes passed. */
async function dueAndUp(...ids: string[]): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + 3_600_000).run();
  for (const id of ids) {
    await env.DB.prepare(
      "UPDATE monitor_state SET state = 'up', next_check_at = 0, active_incident_id = NULL WHERE monitor_id = ?",
    )
      .bind(id)
      .run();
  }
}

async function state(id: string) {
  return env.DB.prepare(
    "SELECT state, next_check_at, active_incident_id, last_error FROM monitor_state WHERE monitor_id = ?",
  )
    .bind(id)
    .first<{ state: string; next_check_at: number; active_incident_id: string | null; last_error: string | null }>();
}

async function openIncidents(id: string) {
  const res = await env.DB.prepare(
    "SELECT id, confirmed, http_status FROM incidents WHERE monitor_id = ? AND status = 'open'",
  )
    .bind(id)
    .all<{ id: string; confirmed: number; http_status: number | null }>();
  return res.results ?? [];
}

async function latestSample(id: string) {
  return env.DB.prepare(
    "SELECT ok, state, attempts, retry_recovered, meta FROM samples WHERE monitor_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
  )
    .bind(id)
    .first<{ ok: number; state: string; attempts: number; retry_recovered: number; meta: string | null }>();
}

async function latestRun() {
  return env.DB.prepare(
    `SELECT ok, monitors_checked, confirmations, confirmations_cleared, confirmations_deferred
     FROM scheduler_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).first<{
    ok: number;
    monitors_checked: number;
    confirmations: number;
    confirmations_cleared: number;
    confirmations_deferred: number;
  }>();
}

const FAST = { confirmDelayMs: 1 };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => vi.restoreAllMocks());

describe("confirm before alerting", () => {
  it("up -> fail -> re-check fails: opens one incident, marked confirmed", async () => {
    const url = "https://confirm-down.example.com/";
    const id = await createMonitor("Confirm down", url);
    await dueAndUp(id);
    const calls = stubTargets({ [url]: [502, 503] });

    await runScheduled(controller, env, FAST);

    expect(calls).toEqual([url, url]);
    expect(await state(id)).toMatchObject({ state: "down", last_error: "status_out_of_range" });
    const incidents = await openIncidents(id);
    expect(incidents).toHaveLength(1);
    // The incident carries the second (deciding) check's status.
    expect(incidents[0]).toMatchObject({ confirmed: 1, http_status: 503 });
    const sample = await latestSample(id);
    expect(sample).toMatchObject({ ok: 0, state: "down", attempts: 2 });
    expect(JSON.parse(sample!.meta!)).toMatchObject({ confirmation: "confirmed" });
    expect(await latestRun()).toMatchObject({
      ok: 1,
      monitors_checked: 1,
      confirmations: 1,
      confirmations_cleared: 0,
      confirmations_deferred: 0,
    });
  });

  it("while down: one check per run, no re-check, and recovery on the first passing check", async () => {
    const url = "https://confirm-down.example.com/";
    const id = (await env.DB.prepare("SELECT id FROM monitors WHERE name = 'Confirm down'").first<{ id: string }>())!.id;
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0 WHERE monitor_id = ?").bind(id).run();

    let calls = stubTargets({ [url]: [503] });
    await runScheduled(controller, env, FAST);
    expect(calls).toEqual([url]);
    expect(await openIncidents(id)).toHaveLength(1);
    expect(await latestRun()).toMatchObject({ confirmations: 0 });

    vi.restoreAllMocks();
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = 0 WHERE monitor_id = ?").bind(id).run();
    calls = stubTargets({ [url]: [200] });
    await runScheduled(controller, env, FAST);
    expect(calls).toEqual([url]);
    expect(await state(id)).toMatchObject({ state: "up", active_incident_id: null });
    expect(await openIncidents(id)).toHaveLength(0);
  });

  it("up -> fail -> re-check passes: no incident, stays up, sample flagged as a blip", async () => {
    const url = "https://confirm-blip.example.com/";
    const id = await createMonitor("Confirm blip", url);
    await dueAndUp(id);
    const calls = stubTargets({ [url]: [502, 200] });

    await runScheduled(controller, env, FAST);

    expect(calls).toEqual([url, url]);
    expect(await state(id)).toMatchObject({ state: "up", active_incident_id: null });
    expect(await openIncidents(id)).toHaveLength(0);
    const sample = await latestSample(id);
    expect(sample).toMatchObject({ ok: 1, state: "up", attempts: 2, retry_recovered: 1 });
    expect(JSON.parse(sample!.meta!)).toMatchObject({ confirmation: "cleared" });
    expect(await latestRun()).toMatchObject({ confirmations: 1, confirmations_cleared: 1 });
    const outbox = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(outbox?.n).toBe(0);
  });

  it("confirm off: the first failure opens an unconfirmed incident with one fetch", async () => {
    const url = "https://confirm-off.example.com/";
    const id = await createMonitor("Confirm off", url, { confirmFailures: "off" });
    const read = await apiRequest(`/api/monitors/${id}`);
    expect((await read.json<{ monitor: { confirmFailures: string } }>()).monitor.confirmFailures).toBe("off");
    await dueAndUp(id);
    const calls = stubTargets({ [url]: [500] });

    await runScheduled(controller, env, FAST);

    expect(calls).toEqual([url]);
    expect(await openIncidents(id)).toEqual([expect.objectContaining({ confirmed: 0 })]);
    expect(await latestRun()).toMatchObject({ confirmations: 0 });
  });

  it("no budget for the re-check: defers instead of alerting unconfirmed, then confirms next run", async () => {
    const url = "https://confirm-budget.example.com/";
    const id = await createMonitor("Confirm budget", url);
    await dueAndUp(id);
    // Room for the check's own fetches (it may follow redirects) beside the
    // room every run keeps for alerts, and nothing more.
    const tight = { ...PLAN_BUDGETS.free, subrequests: 1 + MAX_REDIRECTS + NOTIFICATION_RESERVE };
    let calls = stubTargets({ [url]: [503] });

    await runScheduled(controller, env, { ...FAST, budget: tight });

    expect(calls).toEqual([url]);
    // Nothing written: still up, still due, no incident, no sample from this run.
    expect(await state(id)).toMatchObject({ state: "up", next_check_at: 0, active_incident_id: null });
    expect(await openIncidents(id)).toHaveLength(0);
    expect(await latestRun()).toMatchObject({ monitors_checked: 0, confirmations: 0, confirmations_deferred: 1 });

    vi.restoreAllMocks();
    calls = stubTargets({ [url]: [503] });
    await runScheduled(controller, env, FAST);
    expect(calls).toEqual([url, url]);
    expect(await openIncidents(id)).toEqual([expect.objectContaining({ confirmed: 1 })]);
    expect(await latestRun()).toMatchObject({ confirmations: 1, confirmations_deferred: 0 });
  });

  it("does not re-check a missed heartbeat: there is nothing to check", async () => {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({ type: "heartbeat", name: "Nightly job", config: { intervalSeconds: 3600, graceSeconds: 60 } }),
    });
    const { monitor } = await res.json<{ monitor: { id: string } }>();
    await dueAndUp();
    await env.DB.prepare("UPDATE monitor_state SET state = 'up', last_beat_at = ? WHERE monitor_id = ?")
      .bind(Date.now() - 3 * 3_600_000, monitor.id)
      .run();
    const calls = stubTargets({});

    await runScheduled(controller, env, FAST);

    expect(calls).toEqual([]);
    expect(await openIncidents(monitor.id)).toEqual([expect.objectContaining({ confirmed: 0 })]);
    expect(await latestRun()).toMatchObject({ confirmations: 0 });
  });

  it("shows confirmation counts in diagnostics and the confirmed flag on incidents", async () => {
    const diag = await (await apiRequest("/api/diagnostics")).json<{
      recentRuns: { confirmations: number | null; confirmationsCleared: number | null; confirmationsDeferred: number | null }[];
    }>();
    expect(diag.recentRuns.some((r) => (r.confirmations ?? 0) > 0)).toBe(true);
    expect(diag.recentRuns.some((r) => (r.confirmationsCleared ?? 0) > 0)).toBe(true);
    expect(diag.recentRuns.some((r) => (r.confirmationsDeferred ?? 0) > 0)).toBe(true);

    const list = await (await apiRequest("/api/incidents?status=open")).json<{
      incidents: { monitorName: string; confirmed: boolean }[];
    }>();
    const byName = Object.fromEntries(list.incidents.map((i) => [i.monitorName, i.confirmed]));
    expect(byName).toMatchObject({ "Confirm budget": true, "Confirm off": false, "Nightly job": false });
  });
});
