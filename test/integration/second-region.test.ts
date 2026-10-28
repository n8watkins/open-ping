import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { TRACE_URL, resetKnownColos } from "../../src/worker/checks/region";
import { runScheduled } from "../../src/worker/scheduler";
import type { Env } from "../../src/worker/types";

// Second-region confirmation end to end: the scheduler hands a failed check's
// re-check to the real RegionProbe Durable Object (workerd runs it here), the
// incident and the sample record where it ran, and an install whose Durable
// Object is broken re-checks where the check ran, as before.

const API_ORIGIN = "https://openping.test";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };

/**
 * Stub the network: each target URL answers with the next status in its
 * script (the last one repeats), and Cloudflare's trace says the Durable
 * Object runs in Frankfurt. Returns the target URLs requested, in order.
 */
function stubNetwork(script: Record<string, number[]>): { targets: string[]; traces: () => number } {
  const targets: string[] = [];
  let traces = 0;
  const seen = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === TRACE_URL) {
      traces++;
      return new Response("fl=1\nh=www.cloudflare.com\ncolo=FRA\nloc=DE\n");
    }
    const statuses = script[url];
    if (!statuses) throw new Error(`unexpected outbound request: ${url}`);
    const n = seen.get(url) ?? 0;
    seen.set(url, n + 1);
    targets.push(url);
    const status = statuses[Math.min(n, statuses.length - 1)]!;
    return new Response(status < 400 ? "ok" : "unavailable", { status });
  });
  return { targets, traces: () => traces };
}

async function createMonitor(name: string, url: string): Promise<string> {
  stubNetwork({ [url]: [200] });
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ type: "http", name, config: { url } }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ monitor: { id: string } }>();
  vi.restoreAllMocks();
  return body.monitor.id;
}

async function dueAndUp(id: string): Promise<void> {
  await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + 3_600_000).run();
  await env.DB.prepare(
    "UPDATE monitor_state SET state = 'up', next_check_at = 0, active_incident_id = NULL WHERE monitor_id = ?",
  )
    .bind(id)
    .run();
}

async function openIncident(id: string) {
  return env.DB.prepare(
    "SELECT id, confirmed, confirmed_from, http_status FROM incidents WHERE monitor_id = ? AND status = 'open'",
  )
    .bind(id)
    .first<{ id: string; confirmed: number; confirmed_from: string | null; http_status: number | null }>();
}

async function latestSampleMeta(id: string) {
  const row = await env.DB.prepare(
    "SELECT meta FROM samples WHERE monitor_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
  )
    .bind(id)
    .first<{ meta: string | null }>();
  return row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
}

/** The install with second-region confirmation on, the run itself "in Ashburn". */
const regionalEnv = (): Env => ({ ...env, CONFIRM_REGIONS: "weur,enam" });
const RUN = { confirmDelayMs: 1, regional: { lookupHere: async () => "IAD" } };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetKnownColos();
});

describe("second-region confirmation", () => {
  it("a failure confirmed from Frankfurt opens an incident that says so", async () => {
    const url = "https://region-down.example.com/";
    const id = await createMonitor("Region down", url);
    await dueAndUp(id);
    const net = stubNetwork({ [url]: [502, 503] });

    await runScheduled(controller, regionalEnv(), RUN);

    // The first check here, the re-check inside the Durable Object.
    expect(net.targets).toEqual([url, url]);
    expect(await openIncident(id)).toMatchObject({ confirmed: 1, confirmed_from: "FRA", http_status: 503 });
    expect(await latestSampleMeta(id)).toMatchObject({ confirmation: "confirmed", confirmedFrom: "FRA" });

    const incident = await openIncident(id);
    const detail = await (await apiRequest(`/api/incidents/${incident!.id}`)).json<{
      incident: { confirmed: boolean; confirmedFrom: string | null };
    }>();
    expect(detail.incident).toMatchObject({ confirmed: true, confirmedFrom: "FRA" });
  });

  it("a failure that passes from Frankfurt is a blip: no incident", async () => {
    const url = "https://region-blip.example.com/";
    const id = await createMonitor("Region blip", url);
    await dueAndUp(id);
    stubNetwork({ [url]: [502, 200] });

    await runScheduled(controller, regionalEnv(), RUN);

    expect(await openIncident(id)).toBeNull();
    expect(await latestSampleMeta(id)).toMatchObject({ confirmation: "cleared", confirmedFrom: "FRA" });
  });

  it("the Durable Object remembers where it lives instead of asking every time", async () => {
    const url = "https://region-cached.example.com/";
    const id = await createMonitor("Region cached", url);
    await dueAndUp(id);
    const net = stubNetwork({ [url]: [502, 503] });

    await runScheduled(controller, regionalEnv(), RUN);

    // Frankfurt was looked up by an earlier test's re-check and kept.
    expect(net.traces()).toBe(0);
    expect(await openIncident(id)).toMatchObject({ confirmed_from: "FRA" });
  });

  it("a broken Durable Object degrades to a re-check where the check ran", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = "https://region-broken.example.com/";
    const id = await createMonitor("Region broken", url);
    await dueAndUp(id);
    const net = stubNetwork({ [url]: [502, 503] });
    const broken = {
      idFromName: () => ({}),
      get: () => {
        throw new Error("no such Durable Object");
      },
    } as unknown as Env["REGION_PROBE"];

    await runScheduled(controller, { ...regionalEnv(), REGION_PROBE: broken }, RUN);

    expect(net.targets).toEqual([url, url]);
    expect(await openIncident(id)).toMatchObject({ confirmed: 1, confirmed_from: null, http_status: 503 });
  });

  it("off by default: without CONFIRM_REGIONS the Durable Object is never asked", async () => {
    const url = "https://region-off.example.com/";
    const id = await createMonitor("Region off", url);
    await dueAndUp(id);
    const net = stubNetwork({ [url]: [502, 503] });

    await runScheduled(controller, env, { confirmDelayMs: 1 });

    expect(net.traces()).toBe(0);
    expect(await openIncident(id)).toMatchObject({ confirmed: 1, confirmed_from: null });
  });
});
