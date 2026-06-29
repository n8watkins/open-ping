import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { CheckOutcome } from "./types";
import type { MonitorState } from "../../shared/states";
import { newId } from "../lib/ids";
import { nextCheckAt, nextActivePeriod } from "../lib/schedule";

/**
 * Persists check results to current state + recent samples (PRD §17). Incident
 * lifecycle and history rollups are layered on in Phase 3 — this module owns the
 * mutable `monitor_state` row and the 24h `samples` table only.
 */

interface StateRow {
  state: MonitorState;
  state_since: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
}

async function readState(env: Env, monitorId: string): Promise<StateRow | null> {
  return env.DB.prepare(
    `SELECT state, state_since, last_success_at, consecutive_failures, consecutive_successes
     FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(monitorId)
    .first<StateRow>();
}

async function insertSample(
  env: Env,
  monitorId: string,
  s: {
    at: number;
    ok: boolean;
    state: MonitorState;
    durationMs?: number | null;
    statusCode?: number | null;
    error?: string | null;
    attempts?: number | null;
    warmup?: boolean;
    retryRecovered?: boolean;
    meta?: unknown;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO samples
       (id, monitor_id, at, ok, state, duration_ms, status_code, error, attempts, warmup, retry_recovered, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("smp"),
      monitorId,
      s.at,
      s.ok ? 1 : 0,
      s.state,
      s.durationMs ?? null,
      s.statusCode ?? null,
      s.error ?? null,
      s.attempts ?? null,
      s.warmup ? 1 : 0,
      s.retryRecovered ? 1 : 0,
      s.meta != null ? JSON.stringify(s.meta) : null,
    )
    .run();
}

/** Apply an HTTP check outcome: update current state and write a sample. */
export async function applyCheckResult(
  env: Env,
  monitor: MonitorRecord,
  outcome: CheckOutcome,
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const now = outcome.at;
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";
  const stateChanged = prevState !== outcome.state;
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);
  const consecutiveFailures = outcome.ok ? 0 : (cur?.consecutive_failures ?? 0) + 1;
  const consecutiveSuccesses = outcome.ok ? (cur?.consecutive_successes ?? 0) + 1 : 0;
  const lastSuccessAt = outcome.ok ? now : (cur?.last_success_at ?? null);
  const next = nextCheckAt(
    monitor.schedule,
    new Date(now),
    monitor.intervalSeconds,
  ).getTime();

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
       last_duration_ms = ?, last_status_code = ?, last_error = ?,
       consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
       warmup = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      outcome.state,
      stateSince,
      now,
      lastSuccessAt,
      outcome.durationMs ?? null,
      outcome.statusCode ?? null,
      outcome.error ?? null,
      consecutiveFailures,
      consecutiveSuccesses,
      next,
      outcome.warmup ? 1 : 0,
      now,
      monitor.id,
    )
    .run();

  await insertSample(env, monitor.id, {
    at: now,
    ok: outcome.ok,
    state: outcome.state,
    durationMs: outcome.durationMs,
    statusCode: outcome.statusCode,
    error: outcome.error,
    attempts: outcome.attempts,
    warmup: outcome.warmup,
    retryRecovered: outcome.retryRecovered,
    meta: outcome.assertionFailures?.length
      ? { assertionFailures: outcome.assertionFailures }
      : undefined,
  });

  return { prevState, stateChanged };
}

/** Mark a monitor outside its schedule window. No sample (scheduled-off is neutral). */
export async function setScheduledOff(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  const cur = await readState(env, monitor.id);
  if (cur?.state === "scheduled_off") {
    // Keep next_check_at fresh but avoid resetting state_since.
    const np = nextActivePeriod(monitor.schedule, new Date(now));
    await env.DB.prepare(`UPDATE monitor_state SET next_check_at = ?, updated_at = ? WHERE monitor_id = ?`)
      .bind(np ? np.start.getTime() : now + monitor.intervalSeconds * 1000, now, monitor.id)
      .run();
    return;
  }
  const np = nextActivePeriod(monitor.schedule, new Date(now));
  await env.DB.prepare(
    `UPDATE monitor_state SET state = 'scheduled_off', state_since = ?, next_check_at = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(now, np ? np.start.getTime() : now + monitor.intervalSeconds * 1000, now, monitor.id)
    .run();
}

/** Record a received heartbeat: state up, reset failures, push next deadline. */
export async function recordHeartbeat(
  env: Env,
  monitor: MonitorRecord,
  payload: {
    at: number;
    durationMs?: number;
    exitStatus?: number;
    message?: string;
    runId?: string;
    metrics?: Record<string, number>;
  },
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const now = payload.at;
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";
  const ok = payload.exitStatus == null || payload.exitStatus === 0;
  const state: MonitorState = ok ? "up" : "down";
  const stateChanged = prevState !== state;
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);
  const deadline = now + (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
       last_duration_ms = ?, last_error = ?,
       consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      state,
      stateSince,
      now,
      ok ? now : (cur?.last_success_at ?? null),
      payload.durationMs ?? null,
      ok ? null : `exit_status_${payload.exitStatus}`,
      ok ? 0 : (cur?.consecutive_failures ?? 0) + 1,
      ok ? (cur?.consecutive_successes ?? 0) + 1 : 0,
      deadline,
      now,
      monitor.id,
    )
    .run();

  await insertSample(env, monitor.id, {
    at: now,
    ok,
    state,
    durationMs: payload.durationMs,
    error: ok ? null : `exit_status_${payload.exitStatus}`,
    attempts: 1,
    meta: {
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
    },
  });

  return { prevState, stateChanged };
}

/** Mark a heartbeat monitor as down because no call arrived before the deadline. */
export async function markHeartbeatMissed(env: Env, monitor: MonitorRecord, now: number): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";
  const stateChanged = prevState !== "down";
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = 'down', state_since = ?, last_checked_at = ?, last_error = 'heartbeat_missed',
       consecutive_failures = ?, consecutive_successes = 0, next_check_at = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      stateSince,
      now,
      (cur?.consecutive_failures ?? 0) + 1,
      now + monitor.intervalSeconds * 1000,
      now,
      monitor.id,
    )
    .run();

  if (stateChanged) {
    await insertSample(env, monitor.id, {
      at: now,
      ok: false,
      state: "down",
      error: "heartbeat_missed",
      attempts: 1,
    });
  }

  return { prevState, stateChanged };
}
