import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { createMonitor } from "../../src/worker/db/monitors";
import type { MonitorRecord } from "../../src/worker/db/monitors";
import { applyCheckResult, recordHeartbeat } from "../../src/worker/checks/state";
import type { CheckOutcome } from "../../src/worker/checks/types";
import { bucketStart, compactionStatements, resolveRetention } from "../../src/worker/history/rollups";
import { loadRangeHistory } from "../../src/worker/history/range";
import { buildOverview } from "../../src/worker/routes/overview";
import { createMonitorSchema } from "../../src/shared/schemas";
import { DOWNTIME_STATES, type MonitorState } from "../../src/shared/states";

/**
 * What users see of a monitor's recent checks, against a full recompute.
 *
 * Randomized histories (seeded, so a failure replays) of a 1-minute and a
 * 12-minute HTTP monitor, a DNS monitor whose records change, and a heartbeat,
 * written through the real write path with the upkeep every 12 minutes for
 * 27 hours. The test keeps every check it made; each view must show exactly
 * what that full list gives: the monitor page's recent checks, latest details
 * and 24-hour response times, the 24-hour chart's points, the Overview's last
 * 28 checks, the hourly summaries behind every uptime figure, and the status
 * timeline. However the checks are stored, the numbers stay the same.
 */

const API_ORIGIN = "https://openping.test";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Not on an hour or a 12-minute mark, so windows cut through buckets. */
const T_START = Date.UTC(2026, 9, 20, 3, 7, 13);
const T_END = T_START + 27 * HOUR;

function apiRequest(path: string): Promise<Response> {
  return exports.default.fetch(`${API_ORIGIN}${path}`, {
    headers: { authorization: "Bearer integration-api-token" },
  });
}

/** mulberry32: a small seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One check or beat as the full history keeps it. */
interface Check {
  at: number;
  ok: boolean;
  state: MonitorState;
  durationMs: number | null;
  statusCode: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  retryRecovered: boolean;
  /** Counted in uptime (a warm-up isn't). */
  counted: boolean;
}

interface Sim {
  monitor: MonitorRecord;
  checks: Check[];
}

function outcomeFor(r: () => number, at: number, dns: boolean, first: boolean, records: string[]): CheckOutcome {
  const base = { attempts: 1, warmup: false, retryRecovered: false, fetches: 1, at };
  const ms = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
  const meta = dns ? { records: [...records] } : undefined;
  const code = dns ? {} : { statusCode: 200 };
  if (first) return { ...base, state: "warming_up", ok: false, warmup: true, error: "timeout", durationMs: 10_000 };
  const x = r();
  if (x < 0.78) return { ...base, state: "up", ok: true, durationMs: ms(40, 600), ...code, ...(meta ? { meta } : {}) };
  if (x < 0.82) return { ...base, state: "degraded", ok: true, durationMs: ms(2_000, 4_000), ...code, ...(meta ? { meta } : {}) };
  if (x < 0.9) {
    return {
      ...base,
      state: "down",
      ok: false,
      attempts: 2,
      confirmation: "confirmed",
      error: x < 0.86 ? "timeout" : "status_out_of_range",
      ...(x < 0.86 ? {} : { durationMs: ms(30, 90), statusCode: 503 }),
    };
  }
  if (x < 0.93) {
    return {
      ...base,
      state: "up",
      ok: true,
      attempts: 2,
      retryRecovered: true,
      confirmation: "cleared",
      durationMs: ms(100, 900),
      ...code,
    };
  }
  if (x < 0.96 && !dns) return { ...base, state: "up", ok: true, durationMs: ms(40, 600), statusCode: 204 };
  // A check that measured no time (as a domain check judged from its cache does).
  return { ...base, state: "up", ok: true, ...code, ...(meta ? { meta } : {}) };
}

/** The sample meta the write path builds from an outcome (checks/state.ts). */
function metaOf(o: CheckOutcome): Record<string, unknown> | null {
  const m: Record<string, unknown> = { ...((o.meta as Record<string, unknown> | undefined) ?? {}) };
  if (o.assertionFailures?.length) m.assertionFailures = o.assertionFailures;
  if (o.confirmation === "confirmed" || o.confirmation === "cleared") m.confirmation = o.confirmation;
  return Object.keys(m).length ? m : null;
}

async function polled(name: string, intervalSeconds: number, dns = false): Promise<Sim> {
  const input = createMonitorSchema.parse(
    dns
      ? { type: "dns", name, config: { hostname: `${name.toLowerCase()}.example.com`, recordType: "A" }, intervalSeconds }
      : { type: "http", name, config: { url: `https://${name.toLowerCase()}.example.com/` }, intervalSeconds },
  );
  return { monitor: await createMonitor(env, input), checks: [] };
}

const sims: Sim[] = [];
let fast: Sim;
let slow: Sim;
let dnsSim: Sim;
let beat: Sim;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T_START - MINUTE);
  fast = await polled("Fast", 60);
  slow = await polled("Slow", 720);
  dnsSim = await polled("Records", 300, true);
  beat = {
    monitor: await createMonitor(
      env,
      createMonitorSchema.parse({ type: "heartbeat", name: "Job", config: { intervalSeconds: 300, graceSeconds: 60 } }),
    ),
    checks: [],
  };
  sims.push(fast, slow, dnsSim, beat);

  const r = rng(20261031);
  const retention = resolveRetention(null);
  const records = ["192.0.2.1"];
  // Every event in time order: each monitor's checks (a little jitter, as a
  // run's checks finish at different moments), the beats, and the upkeep.
  type Event = { at: number; run: () => Promise<void> };
  const events: Event[] = [];
  const jitter = () => Math.floor(r() * 9_000);
  for (const sim of [fast, slow, dnsSim]) {
    const step = sim.monitor.intervalSeconds * 1000;
    const dns = sim === dnsSim;
    let first = true;
    for (let t = T_START; t < T_END; t += step) {
      const at = t + jitter();
      const isFirst = first;
      first = false;
      events.push({
        at,
        run: async () => {
          if (dns && r() < 0.05) records[0] = `192.0.2.${1 + Math.floor(r() * 200)}`;
          const o = outcomeFor(r, at, dns, isFirst, records);
          await applyCheckResult(env, sim.monitor, o);
          sim.checks.push({
            at,
            ok: o.ok,
            state: o.state,
            durationMs: o.durationMs ?? null,
            statusCode: o.statusCode ?? null,
            error: o.error ?? null,
            meta: metaOf(o),
            retryRecovered: o.retryRecovered,
            counted: o.state !== "warming_up" && o.state !== "cant_check",
          });
        },
      });
    }
  }
  for (let t = T_START + 20_000; t < T_END; t += 300_000) {
    const at = t + jitter();
    events.push({
      at,
      run: async () => {
        const x = r();
        const ok = x < 0.9;
        const message = x > 0.8 ? `run ${Math.floor(x * 1000)}` : undefined;
        const durationMs = r() < 0.7 ? Math.round(1_000 + r() * 50_000) : undefined;
        await recordHeartbeat(env, beat.monitor, {
          at,
          ...(ok ? {} : { exitStatus: 2 }),
          ...(message ? { message } : {}),
          ...(durationMs != null ? { durationMs } : {}),
        });
        beat.checks.push({
          at,
          ok,
          state: ok ? "up" : "down",
          durationMs: durationMs ?? null,
          statusCode: null,
          error: ok ? null : "exit_status_2",
          meta: message ? { message } : null,
          retryRecovered: false,
          counted: true,
        });
      },
    });
  }
  let since: number | null = null;
  for (let t = T_START + 12 * MINUTE; t < T_END; t += 12 * MINUTE) {
    const at = t;
    events.push({
      at,
      run: async () => {
        await env.DB.batch(compactionStatements(env, at, retention, since).map((s) => s.stmt));
        since = at;
      },
    });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    vi.setSystemTime(e.at);
    await e.run();
  }
  vi.setSystemTime(T_END);
}, 240_000);

afterAll(() => {
  vi.useRealTimers();
});

const NOW = T_END;
const recent = (sim: Sim, from = NOW - DAY) => sim.checks.filter((c) => c.at >= from && c.at <= NOW);

describe("the monitor page", { timeout: 60_000 }, () => {
  it("lists every check of the last 24 hours, with the latest one's details", async () => {
    for (const sim of sims) {
      const res = await apiRequest(`/api/monitors/${sim.monitor.id}/detail`);
      expect(res.status).toBe(200);
      const body = await res.json<{ recentSamples: Record<string, unknown>[] }>();
      const want: Record<string, unknown>[] = recent(sim).map((c) => ({
        at: c.at,
        ok: c.ok ? 1 : 0,
        state: c.state,
        durationMs: c.durationMs,
        statusCode: c.statusCode,
        error: c.error,
      }));
      const last = recent(sim).at(-1)!;
      if (last.meta) want[want.length - 1] = { ...want.at(-1), meta: last.meta };
      // A beat without a message used to keep an empty meta object: the same nothing.
      const got = body.recentSamples.map((s) =>
        s.meta && typeof s.meta === "object" && Object.keys(s.meta).length === 0 ? (({ meta: _m, ...rest }) => rest)(s) : s,
      );
      expect(got, sim.monitor.name).toEqual(want);
    }
  });

  it("reports the last 24 hours' response time from every passing check", async () => {
    for (const sim of sims) {
      const res = await apiRequest(`/api/monitors/${sim.monitor.id}/detail`);
      const body = await res.json<{ latency: { avg: number | null; min: number | null; max: number | null } }>();
      const ms = recent(sim)
        .filter((c) => c.ok && c.durationMs != null)
        .map((c) => c.durationMs!);
      expect(body.latency.min, sim.monitor.name).toBe(Math.min(...ms));
      expect(body.latency.max, sim.monitor.name).toBe(Math.max(...ms));
      expect(body.latency.avg!, sim.monitor.name).toBeCloseTo(ms.reduce((a, b) => a + b, 0) / ms.length, 6);
    }
  });
});

describe("the 24-hour chart", { timeout: 60_000 }, () => {
  it("plots every passing check's response time, and its percentiles come from all of them", async () => {
    for (const sim of sims) {
      const h = await loadRangeHistory(env, "24h", NOW, sim.monitor.id);
      const want = recent(sim, h.from)
        .filter((c) => c.ok && c.durationMs != null)
        .map((c) => ({ t: c.at, ms: c.durationMs! }));
      expect(h.samples.get(sim.monitor.id) ?? [], sim.monitor.name).toEqual(want);
      const sorted = want.map((p) => p.ms).sort((a, b) => a - b);
      expect(h.monitors[0]!.latency.basis).toBe("checks");
      expect(h.monitors[0]!.latency.max).toBe(sorted.at(-1));
      expect(h.monitors[0]!.latency.min).toBe(sorted[0]);
    }
  });

  it("takes the all-monitors view's percentiles from every check while no monitor is checked every minute", async () => {
    await env.DB.prepare("UPDATE monitors SET interval_seconds = 720 WHERE type <> 'heartbeat'").run();
    try {
      const h = await loadRangeHistory(env, "24h", NOW);
      for (const sim of sims) {
        const want = recent(sim, h.from)
          .filter((c) => c.ok && c.durationMs != null)
          .map((c) => ({ t: c.at, ms: c.durationMs! }));
        expect(h.samples.get(sim.monitor.id) ?? [], sim.monitor.name).toEqual(want);
      }
      expect(h.overall.latency.basis).toBe("checks");
      const all = sims.flatMap((sim) => recent(sim, h.from).filter((c) => c.ok && c.durationMs != null));
      expect(h.overall.latency.max).toBe(Math.max(...all.map((c) => c.durationMs!)));
    } finally {
      await env.DB.batch(
        [fast, dnsSim].map((sim) =>
          env.DB.prepare("UPDATE monitors SET interval_seconds = ? WHERE id = ?").bind(sim.monitor.intervalSeconds, sim.monitor.id),
        ),
      );
    }
  });
});

describe("the Overview", { timeout: 60_000 }, () => {
  it("shows each monitor's last 28 checks of the day and its 24-hour uptime", async () => {
    const overview = await buildOverview(env, NOW);
    for (const sim of sims) {
      const row = overview.monitors.find((m) => m.id === sim.monitor.id)!;
      const want = recent(sim)
        .slice(-28)
        .map((c) => ({ at: c.at, state: c.state }));
      expect(row.recentChecks, sim.monitor.name).toEqual(want);
      const counted = sim.checks.filter((c) => c.counted && bucketStart("hour", c.at) >= NOW - DAY);
      const ok = counted.filter((c) => c.ok).length;
      expect(row.uptime24h, sim.monitor.name).toBeCloseTo(counted.length ? (ok / counted.length) * 100 : 100, 9);
    }
  });
});

describe("the rollups and the timeline", { timeout: 60_000 }, () => {
  it("hold the same hourly totals as a recompute from every check", async () => {
    for (const sim of sims) {
      const want = new Map<number, Record<string, number | null>>();
      for (const c of sim.checks.filter((x) => x.counted)) {
        const b = bucketStart("hour", c.at);
        const t = want.get(b) ?? {
          checks: 0,
          ok_checks: 0,
          fail_checks: 0,
          retry_recoveries: 0,
          sum_latency_ms: 0,
          min_latency_ms: null,
          max_latency_ms: null,
          monitored_seconds: 0,
          down_seconds: 0,
        };
        const interval = sim.monitor.intervalSeconds;
        t.checks! += 1;
        t.ok_checks! += c.ok ? 1 : 0;
        t.fail_checks! += c.ok ? 0 : 1;
        t.retry_recoveries! += c.retryRecovered ? 1 : 0;
        t.sum_latency_ms! += c.ok && c.durationMs != null ? c.durationMs : 0;
        if (c.durationMs != null) {
          t.min_latency_ms = t.min_latency_ms == null ? c.durationMs : Math.min(t.min_latency_ms, c.durationMs);
          t.max_latency_ms = t.max_latency_ms == null ? c.durationMs : Math.max(t.max_latency_ms, c.durationMs);
        }
        t.monitored_seconds! += interval;
        t.down_seconds! += DOWNTIME_STATES.has(c.state) ? interval : 0;
        want.set(b, t);
      }
      const { results } = await env.DB.prepare(
        `SELECT bucket_start, checks, ok_checks, fail_checks, retry_recoveries, sum_latency_ms,
                min_latency_ms, max_latency_ms, monitored_seconds, down_seconds
           FROM summaries WHERE monitor_id = ? AND period = 'hour' ORDER BY bucket_start`,
      )
        .bind(sim.monitor.id)
        .all<Record<string, number | null> & { bucket_start: number }>();
      const got = new Map(results.map(({ bucket_start, ...rest }) => [bucket_start, rest]));
      // A beat after a missed beat credits no monitored time; none are missed here.
      expect(got, sim.monitor.name).toEqual(want);
    }
  });

  it("keeps one status interval per run of the same state", async () => {
    for (const sim of sims) {
      const want: { state: string; started_at: number; ended_at: number | null }[] = [];
      for (const c of sim.checks) {
        const open = want.at(-1);
        if (open && open.state === c.state) continue;
        if (open) open.ended_at = c.at;
        want.push({ state: c.state, started_at: c.at, ended_at: null });
      }
      const { results } = await env.DB.prepare(
        "SELECT state, started_at, ended_at FROM status_intervals WHERE monitor_id = ? ORDER BY started_at",
      )
        .bind(sim.monitor.id)
        .all();
      expect(results, sim.monitor.name).toEqual(want);
    }
  });
});
