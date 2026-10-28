import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { recordHeartbeat } from "../../src/worker/checks/state";
import { getMonitor } from "../../src/worker/db/monitors";
import { runScheduled } from "../../src/worker/scheduler";

// A cron run plans its writes from the state it read at its start and sends
// them at its end (checks/state.ts). A heartbeat that arrives in between is
// recorded at once by its own request (routes/heartbeats.ts), so the run's
// writes must not undo it. These runs record a beat at exactly that moment:
// just before the run's write batch reaches D1.

const API_ORIGIN = "https://openping.test";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}

const controller: ScheduledController = { cron: "*/12 * * * *", scheduledTime: Date.now(), noRetry() {} };

/** A D1 binding that runs `beforeWrites` just before the run's second batch (its writes). */
function interceptedD1(db: D1Database, beforeWrites: () => Promise<void>): D1Database {
  let batches = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) await beforeWrites();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createHeartbeat(name: string): Promise<string> {
  const res = await apiRequest("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ type: "heartbeat", name, config: { intervalSeconds: 3600, graceSeconds: 60 } }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ monitor: { id: string } }>()).monitor.id;
}

const stateOf = (id: string) =>
  env.DB.prepare(
    "SELECT state, last_beat_at, last_error, active_incident_id FROM monitor_state WHERE monitor_id = ?",
  )
    .bind(id)
    .first<{ state: string; last_beat_at: number; last_error: string | null; active_incident_id: string | null }>();

const openIncidents = async (id: string) =>
  (
    await env.DB.prepare("SELECT id FROM incidents WHERE monitor_id = ? AND status = 'open'")
      .bind(id)
      .all<{ id: string }>()
  ).results;

/** Only this monitor is on, so the run plans writes for it alone. */
async function only(id: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE monitors SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(id),
    env.DB.prepare("DELETE FROM maintenance_windows"),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => vi.restoreAllMocks());

describe("a heartbeat recorded while a run is under way", () => {
  it("survives the run's warm-up write, failing beat, open incident and all", async () => {
    const id = await createHeartbeat("Race warm-up");
    await only(id);
    const oldBeat = Date.now() - 3 * 86_400_000;
    // Back on schedule after a gap: the run plans a warm-up grace cycle.
    await env.DB.prepare("UPDATE monitor_state SET state = 'scheduled_off', last_beat_at = ? WHERE monitor_id = ?")
      .bind(oldBeat, id)
      .run();
    const monitor = (await getMonitor(env, id))!;
    let beatAt = 0;

    await runScheduled(
      controller,
      {
        ...env,
        DB: interceptedD1(env.DB, async () => {
          beatAt = Date.now();
          // The job ran and failed (exit 1), reported while the run was still going.
          await recordHeartbeat(env, monitor, { at: beatAt, exitStatus: 1 });
        }),
      },
    );

    expect(beatAt).toBeGreaterThan(0);
    const st = await stateOf(id);
    expect(st).toMatchObject({ state: "down", last_beat_at: beatAt, last_error: "exit_status_1" });
    const open = await openIncidents(id);
    expect(open).toHaveLength(1);
    expect(st?.active_incident_id).toBe(open[0]!.id);
  });

  it("keeps an open incident and its pointer when the beat says the monitor is down, not in maintenance", async () => {
    const id = await createHeartbeat("Race maintenance, disagreeing");
    await only(id);
    const monitor = (await getMonitor(env, id))!;
    // Down with an open incident.
    await recordHeartbeat(env, monitor, { at: Date.now() - 60_000, exitStatus: 1 });
    expect(await openIncidents(id)).toHaveLength(1);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO maintenance_windows (id, title, scope, starts_at, ends_at, created_at, updated_at)
       VALUES ('mw_race', 'Race', 'global', ?, ?, ?, ?)`,
    )
      .bind(now - 1000, now + 3_600_000, now, now)
      .run();

    let beatAt = 0;
    await runScheduled(controller, {
      ...env,
      DB: interceptedD1(env.DB, async () => {
        beatAt = Date.now();
        await recordHeartbeat(env, monitor, { at: beatAt, exitStatus: 1 });
      }),
    });

    // The run's maintenance write (planned from the old snapshot) stood aside.
    const st = await stateOf(id);
    expect(st).toMatchObject({ state: "down", last_beat_at: beatAt });
    const open = await openIncidents(id);
    expect(open).toHaveLength(1);
    expect(st?.active_incident_id).toBe(open[0]!.id);
  });

  it("still resolves the incident when the beat agrees the monitor is in maintenance", async () => {
    const id = await createHeartbeat("Race maintenance, agreeing");
    await only(id);
    const monitor = (await getMonitor(env, id))!;
    await recordHeartbeat(env, monitor, { at: Date.now() - 60_000, exitStatus: 1 });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO maintenance_windows (id, title, scope, starts_at, ends_at, created_at, updated_at)
       VALUES ('mw_race2', 'Race', 'global', ?, ?, ?, ?)`,
    )
      .bind(now - 1000, now + 3_600_000, now, now)
      .run();

    let beatAt = 0;
    await runScheduled(controller, {
      ...env,
      DB: interceptedD1(env.DB, async () => {
        beatAt = Date.now();
        await recordHeartbeat(env, monitor, { at: beatAt }, { maintenance: true });
      }),
    });

    const st = await stateOf(id);
    expect(st).toMatchObject({ state: "maintenance", last_beat_at: beatAt, active_incident_id: null });
    expect(await openIncidents(id)).toHaveLength(0);
  });
});
