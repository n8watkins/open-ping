import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { PLAN_BUDGETS } from "../../src/worker/lib/budget";
import { runScheduled } from "../../src/worker/scheduler";

// How many D1 round trips (what Cloudflare's 50-per-invocation Free limit
// counts: a query, or a whole batch) and statements a cron run makes for N due
// monitors, in each phase of a check's life: the first (warm-up) check, a
// passing check, a failing check that opens an incident and queues an alert,
// and the passing check that resolves it. docs/FREE_TIER.md quotes these.

const API_ORIGIN = "https://openping.test";
const SIZES = [1, 3, 10, 30] as const;
const MAX = 30;

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

interface Counts {
  roundTrips: number;
  statements: number;
  /** Alert deliveries the run attempted (each costs its own queries; notifications/dispatcher.ts). */
  deliveries?: number;
}

/** Deliveries attempted since `since`: each one is marked sent or failed when tried. */
const deliveredSince = async (since: number) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_outbox WHERE status <> 'pending' AND updated_at >= ?",
    )
      .bind(since)
      .first<{ n: number }>()
  )?.n ?? 0;

/** A D1 binding that counts round trips (a query or a whole batch) and the statements in them. */
function measuringD1(db: D1Database, counts: Counts): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "first" || prop === "run" || prop === "all" || prop === "raw") {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          return (...args: unknown[]) => {
            counts.roundTrips++;
            counts.statements++;
            return fn.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counts.roundTrips++;
          counts.statements += statements.length;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One run on the Paid budget (so all N fit) with every target answering `status`. */
async function measuredRun(status: number): Promise<Counts> {
  const counts: Counts = { roundTrips: 0, statements: 0 };
  const started = Date.now();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(status < 400 ? "ok" : "down", { status }),
  );
  await runScheduled(
    controller,
    { ...env, DB: measuringD1(env.DB, counts) },
    { budget: PLAN_BUDGETS.paid, confirmDelayMs: 0 },
  );
  vi.restoreAllMocks();
  counts.deliveries = await deliveredSince(started);
  return counts;
}

async function latestRun() {
  return env.DB.prepare(
    "SELECT monitors_checked, d1_queries FROM scheduler_runs ORDER BY started_at DESC LIMIT 1",
  ).first<{ monitors_checked: number; d1_queries: number }>();
}

const allDue = () => env.DB.prepare("UPDATE monitor_state SET next_check_at = 0").run();

const ids: string[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  // One alert channel, so an incident queues a delivery like a real install.
  const channel = await apiRequest("/api/channels", {
    method: "POST",
    body: JSON.stringify({ type: "webhook", name: "Measure", config: { url: "https://hooks.example.com/x" } }),
  });
  expect(channel.status).toBe(201);
  for (let i = 0; i < MAX; i++) {
    const res = await apiRequest("/api/monitors", {
      method: "POST",
      body: JSON.stringify({
        type: "http",
        name: `Writes monitor ${String(i).padStart(2, "0")}`,
        config: { url: `https://w${i}.example.com/` },
      }),
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { monitor: { id: string } }).monitor.id);
  }
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("D1 round trips per scheduler run", () => {
  const table: string[] = [];

  it.each(SIZES)("measures a run with %i due monitors", async (n) => {
    // Only the first n monitors are on, each starting never checked.
    await env.DB.batch([
      env.DB.prepare("UPDATE monitors SET enabled = 0"),
      env.DB.prepare(`UPDATE monitors SET enabled = 1 WHERE id IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(ids.slice(0, n)),
      ),
      // A fresh start: no recent incidents (flap detection) or alerts (cooldown).
      env.DB.prepare("UPDATE monitor_state SET active_incident_id = NULL"),
      env.DB.prepare("DELETE FROM incidents"),
      env.DB.prepare("DELETE FROM notification_outbox"),
      env.DB.prepare("DELETE FROM status_intervals"),
      env.DB.prepare(
        `UPDATE monitor_state SET state = 'unknown', next_check_at = 0, active_incident_id = NULL,
           is_flapping = 0, consecutive_failures = 0, consecutive_successes = 0`,
      ),
    ]);

    const since = Date.now();
    const warmup = await measuredRun(200);
    await allDue();
    const passing = await measuredRun(200);
    expect((await latestRun())?.monitors_checked).toBe(n);
    await allDue();
    const failing = await measuredRun(500);
    await allDue();
    const recovering = await measuredRun(200);
    expect((await latestRun())?.d1_queries).toBe(recovering.roundTrips);

    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM incidents WHERE status = 'resolved' AND resolved_at IS NOT NULL
         AND started_at >= ? AND monitor_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(since, JSON.stringify(ids.slice(0, n)))
      .first<{ n: number }>();
    expect(open?.n).toBe(n);

    // The status timeline, kept without reading it first (db/intervals.ts):
    // one interval per state, extended in place while the state holds.
    const timeline = await env.DB.prepare(
      `SELECT state, checks, ok_checks, reason, ended_at IS NULL AS open FROM status_intervals
        WHERE monitor_id = ? AND started_at >= ? ORDER BY started_at`,
    )
      .bind(ids[0], since)
      .all<{ state: string; checks: number; ok_checks: number; reason: string | null; open: number }>();
    expect(timeline.results).toEqual([
      // The first interval has no reason; the warm-up check passed, so it is up.
      expect.objectContaining({ state: "up", checks: 2, ok_checks: 2, reason: null, open: 0 }),
      expect.objectContaining({ state: "down", checks: 1, ok_checks: 0, reason: "state_change", open: 0 }),
      expect.objectContaining({ state: "up", checks: 1, ok_checks: 1, reason: "state_change", open: 1 }),
    ]);

    // Every check's writes share the run's batches: a run of passing checks is
    // the idle run's three round trips, and one that opens or resolves
    // incidents adds one shared read batch. Only delivering alerts costs per
    // alert (notifications/dispatcher.ts): the channel is read once per run,
    // then each delivery is marked and its channel's result recorded.
    expect(warmup.roundTrips).toBe(3);
    expect(passing.roundTrips).toBe(3);
    expect(failing.roundTrips - 2 * failing.deliveries!).toBe(4 + 1);
    expect(recovering.roundTrips - 2 * recovering.deliveries!).toBe(4 + 1);
    expect(failing.deliveries).toBe(Math.min(n, 25));

    const row = (c: Counts) =>
      `${c.roundTrips} (${c.statements} stmts${c.deliveries ? `, ${c.deliveries} alerts` : ""})`;
    table.push(
      `| ${n} | ${row(warmup)} | ${row(passing)} | ${row(failing)} | ${row(recovering)} |`,
    );
    if (n === SIZES.at(-1)) {
      console.log(
        [
          "[writes] D1 round trips per run (statements in brackets)",
          "| due monitors | warm-up | passing | failing, opens incidents | recovering |",
          "| --- | --- | --- | --- | --- |",
          ...table,
        ].join("\n"),
      );
    }
  }, 60_000);
});

describe("one failing write in a run's batch", () => {
  /** Make every statement that writes `table` for this monitor fail, as a broken row would. */
  async function breakWrites(table: "samples" | "incidents", monitorId: string) {
    await env.DB.prepare(
      `CREATE TRIGGER broken_${table} BEFORE INSERT ON ${table}
         WHEN NEW.monitor_id = '${monitorId}'
         BEGIN SELECT RAISE(ABORT, 'broken for this test'); END`,
    ).run();
  }
  const repair = (table: string) => env.DB.prepare(`DROP TRIGGER IF EXISTS broken_${table}`).run();

  async function reset(n: number, state: string) {
    await env.DB.batch([
      env.DB.prepare("UPDATE monitors SET enabled = 0"),
      env.DB.prepare(`UPDATE monitors SET enabled = 1 WHERE id IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(ids.slice(0, n)),
      ),
      env.DB.prepare("UPDATE monitor_state SET active_incident_id = NULL"),
      env.DB.prepare("DELETE FROM incidents"),
      env.DB.prepare("DELETE FROM notification_outbox"),
      env.DB.prepare(
        `UPDATE monitor_state SET state = ?, next_check_at = 0, is_flapping = 0, consecutive_failures = 0`,
      ).bind(state),
    ]);
  }

  const stateOf = (id: string) =>
    env.DB.prepare(
      "SELECT state, next_check_at, active_incident_id, last_checked_at FROM monitor_state WHERE monitor_id = ?",
    )
      .bind(id)
      .first<{ state: string; next_check_at: number; active_incident_id: string | null; last_checked_at: number }>();
  const count = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

  afterEach(async () => {
    await repair("samples");
    await repair("incidents");
  });

  it("still records every other monitor's check, and the broken one's state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reset(3, "up");
    const [a, broken, c] = ids;
    await breakWrites("samples", broken!);
    const since = Date.now();
    const run = await measuredRun(200);

    for (const id of [a!, c!]) {
      expect((await stateOf(id))?.last_checked_at).toBeGreaterThanOrEqual(since);
      expect(await count("SELECT COUNT(*) AS n FROM samples WHERE monitor_id = ? AND at >= ?", id, since)).toBe(1);
    }
    // The broken monitor's state landed without its sample, so it isn't checked again at once.
    const b = await stateOf(broken!);
    expect(b?.last_checked_at).toBeGreaterThanOrEqual(since);
    expect(b?.next_check_at).toBeGreaterThan(since);
    expect(await count("SELECT COUNT(*) AS n FROM samples WHERE monitor_id = ? AND at >= ?", broken!, since)).toBe(0);
    // Its rollup is independent of the sample and landed too.
    expect(
      await count("SELECT COUNT(*) AS n FROM summaries WHERE monitor_id = ? AND period = 'hour'", broken!),
    ).toBeGreaterThan(0);
    expect(await latestRun()).toMatchObject({ monitors_checked: 3 });
    // A failed batch is retried in parts, still well inside the Free plan's 50.
    expect(run.roundTrips).toBeLessThan(15);
  });

  it("never leaves a monitor pointing at an incident that wasn't opened, and opens it next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reset(3, "up");
    const [a, broken, c] = ids;
    await breakWrites("incidents", broken!);
    await measuredRun(500);

    for (const id of [a!, c!]) {
      const st = await stateOf(id);
      expect(st?.state).toBe("down");
      expect(st?.active_incident_id).not.toBeNull();
      expect(
        await count("SELECT COUNT(*) AS n FROM incidents WHERE id = ? AND status = 'open'", st!.active_incident_id),
      ).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?", id)).toBe(1);
    }
    const b = await stateOf(broken!);
    expect(b?.state).toBe("down");
    expect(b?.active_incident_id).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ?", broken!)).toBe(0);
    // No alert for an incident that doesn't exist.
    expect(await count("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?", broken!)).toBe(0);

    // Repaired: the next check opens the incident and alerts.
    await repair("incidents");
    await allDue();
    await measuredRun(500);
    const after = await stateOf(broken!);
    expect(after?.active_incident_id).not.toBeNull();
    expect(
      await count("SELECT COUNT(*) AS n FROM incidents WHERE id = ? AND status = 'open'", after!.active_incident_id),
    ).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?", broken!)).toBe(1);
  });

  it("queues an incident's alert on a later run when the write that queues it didn't land", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reset(3, "up");
    const [a, broken] = ids;
    await env.DB.prepare(
      `CREATE TRIGGER broken_outbox BEFORE INSERT ON notification_outbox
         WHEN NEW.monitor_id = '${broken}'
         BEGIN SELECT RAISE(ABORT, 'broken for this test'); END`,
    ).run();
    try {
      await measuredRun(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS broken_outbox").run();
    }
    const incidentOf = (id: string) =>
      env.DB.prepare("SELECT id, notified FROM incidents WHERE monitor_id = ? AND status = 'open'")
        .bind(id)
        .first<{ id: string; notified: number }>();
    // The incident opened, but its alert wasn't queued: it is still owed one.
    expect(await incidentOf(broken!)).toMatchObject({ notified: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?", broken!)).toBe(0);
    expect(await incidentOf(a!)).toMatchObject({ notified: 1 });

    // The next run (nothing is due) queues it, once, with the event key it
    // would have had, and delivers it.
    const owed = (await incidentOf(broken!))!;
    await env.DB.prepare("UPDATE monitor_state SET next_check_at = ?").bind(Date.now() + 3_600_000).run();
    await measuredRun(200);
    expect(await incidentOf(broken!)).toMatchObject({ notified: 1 });
    const queued = await env.DB.prepare("SELECT event_key, status FROM notification_outbox WHERE monitor_id = ?")
      .bind(broken)
      .all<{ event_key: string; status: string }>();
    expect(queued.results).toHaveLength(1);
    expect(queued.results[0]!.event_key).toMatch(new RegExp(`^down:${owed.id}:`));
    expect(queued.results[0]!.status).not.toBe("pending");
    // And not again.
    await measuredRun(200);
    expect(await count("SELECT COUNT(*) AS n FROM notification_outbox WHERE monitor_id = ?", broken!)).toBe(1);
  });

  it("keeps a Free run of many due monitors inside its D1 budget even when its batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reset(MAX, "up");
    await breakWrites("samples", ids[0]!);
    const counts: Counts = { roundTrips: 0, statements: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await runScheduled(controller, { ...env, DB: measuringD1(env.DB, counts) }, { budget: PLAN_BUDGETS.free });
    expect(counts.roundTrips).toBeLessThanOrEqual(PLAN_BUDGETS.free.d1Queries);
    const run = await latestRun();
    expect(run?.d1_queries).toBe(counts.roundTrips);
    // Every monitor whose writes it could afford landed (the broken one's state too).
    expect(run?.monitors_checked).toBeGreaterThan(0);
  });
});
