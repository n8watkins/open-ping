import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { CheckOutcome } from "./types";
import type { MonitorState } from "../../shared/states";
import { newId } from "../lib/ids";
import { nextCheckAt, nextActivePeriod } from "../lib/schedule";
import {
  getActiveIncident,
  openIncident,
  recordObservation,
  resolveIncident,
  countRecentIncidents,
} from "../db/incidents";
import { updateStatusInterval } from "../db/intervals";
import { recordCheckSample } from "../history/rollups";
import { enqueueIncidentEvent } from "../notifications/enqueue";
import type { NotifyEvent } from "../../shared/notifications";

/**
 * Persists check results: mutable current state, recent samples, incident
 * lifecycle, evolving status intervals, and hourly rollups (PRD §11, §17).
 * Auxiliary writes (intervals, rollups, incidents) are wrapped so a failure in
 * one never prevents the core state + sample write.
 */

const FLAP_WINDOW_MS = 60 * 60 * 1000;
const FLAP_THRESHOLD = 3;

interface StateRow {
  state: MonitorState;
  state_since: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  active_incident_id: string | null;
  is_flapping: number;
}

async function readState(env: Env, monitorId: string): Promise<StateRow | null> {
  return env.DB.prepare(
    `SELECT state, state_since, last_success_at, consecutive_failures,
            consecutive_successes, active_incident_id, is_flapping
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

/**
 * Open/observe/resolve the active incident for a failed/recovered check.
 * Returns the incident pointer + flapping flag to store on monitor_state.
 * Tolerant of errors — incident bookkeeping must not abort a check.
 */
async function applyIncidentTransition(
  env: Env,
  monitor: MonitorRecord,
  p: { ok: boolean; at: number; error?: string | null; httpStatus?: number | null },
  downEvent: NotifyEvent = "down",
): Promise<{ activeIncidentId: string | null; isFlapping: boolean }> {
  try {
    const active = await getActiveIncident(env, monitor.id);
    if (!p.ok) {
      if (active) {
        await recordObservation(env, active.id, {
          at: p.at,
          error: p.error,
          httpStatus: p.httpStatus,
        });
        return { activeIncidentId: active.id, isFlapping: active.isFlapping };
      }
      // Opening a new incident — flag flapping if too many recently.
      const recent = await countRecentIncidents(env, monitor.id, p.at - FLAP_WINDOW_MS);
      const flapping = recent + 1 >= FLAP_THRESHOLD;
      const inc = await openIncident(env, monitor, {
        at: p.at,
        error: p.error,
        httpStatus: p.httpStatus,
        isFlapping: flapping,
      });
      // Single flapping warning instead of yet another down alert.
      await safe("notify", () =>
        enqueueIncidentEvent(env, monitor, inc, flapping ? "flapping" : downEvent),
      );
      return { activeIncidentId: inc.id, isFlapping: flapping };
    }
    if (active) {
      const resolved = await resolveIncident(env, active.id, { at: p.at });
      await safe("notify", () =>
        enqueueIncidentEvent(env, monitor, resolved ?? active, "recovered"),
      );
    }
    return { activeIncidentId: null, isFlapping: false };
  } catch (e) {
    console.error(`[incident] transition failed for ${monitor.id}`, e);
    return { activeIncidentId: null, isFlapping: false };
  }
}

async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[state] ${label} failed`, e);
  }
}

/** Apply an HTTP check outcome: state, sample, incident, interval, rollup. */
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
  const next = nextCheckAt(monitor.schedule, new Date(now), monitor.intervalSeconds).getTime();

  const incident = await applyIncidentTransition(env, monitor, {
    ok: outcome.ok,
    at: now,
    error: outcome.error,
    httpStatus: outcome.statusCode,
  });

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
       last_duration_ms = ?, last_status_code = ?, last_error = ?,
       consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
       warmup = ?, active_incident_id = ?, is_flapping = ?, updated_at = ?
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
      incident.activeIncidentId,
      incident.isFlapping ? 1 : 0,
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

  await safe("interval", () =>
    updateStatusInterval(env, monitor.id, outcome.state, now, {
      latencyMs: outcome.durationMs,
      ok: outcome.ok,
    }),
  );
  await safe("rollup", () =>
    recordCheckSample(env, monitor.id, {
      at: now,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      retryRecovered: outcome.retryRecovered,
      monitoredSeconds: monitor.intervalSeconds,
      downSeconds: outcome.state === "down" ? monitor.intervalSeconds : 0,
    }),
  );

  return { prevState, stateChanged };
}

/** Mark a monitor outside its schedule window. No sample/incident/rollup. */
export async function setScheduledOff(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  const cur = await readState(env, monitor.id);
  const np = nextActivePeriod(monitor.schedule, new Date(now));
  const nextAt = np ? np.start.getTime() : now + monitor.intervalSeconds * 1000;

  if (cur?.state === "scheduled_off") {
    await env.DB.prepare(`UPDATE monitor_state SET next_check_at = ?, updated_at = ? WHERE monitor_id = ?`)
      .bind(nextAt, now, monitor.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE monitor_state SET state = 'scheduled_off', state_since = ?, next_check_at = ?, updated_at = ?
       WHERE monitor_id = ?`,
    )
      .bind(now, nextAt, now, monitor.id)
      .run();
  }
  await safe("interval", () =>
    updateStatusInterval(env, monitor.id, "scheduled_off", now, { reason: "schedule_window" }),
  );
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
  const error = ok ? null : `exit_status_${payload.exitStatus}`;

  const incident = await applyIncidentTransition(env, monitor, { ok, at: now, error });

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
       last_duration_ms = ?, last_error = ?,
       consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
       active_incident_id = ?, is_flapping = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      state,
      stateSince,
      now,
      ok ? now : (cur?.last_success_at ?? null),
      payload.durationMs ?? null,
      error,
      ok ? 0 : (cur?.consecutive_failures ?? 0) + 1,
      ok ? (cur?.consecutive_successes ?? 0) + 1 : 0,
      deadline,
      incident.activeIncidentId,
      incident.isFlapping ? 1 : 0,
      now,
      monitor.id,
    )
    .run();

  await insertSample(env, monitor.id, {
    at: now,
    ok,
    state,
    durationMs: payload.durationMs,
    error,
    attempts: 1,
    meta: {
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
    },
  });

  await safe("interval", () =>
    updateStatusInterval(env, monitor.id, state, now, { latencyMs: payload.durationMs, ok }),
  );
  await safe("rollup", () =>
    recordCheckSample(env, monitor.id, {
      at: now,
      ok,
      durationMs: payload.durationMs,
      monitoredSeconds: monitor.intervalSeconds,
      downSeconds: ok ? 0 : monitor.intervalSeconds,
    }),
  );

  return { prevState, stateChanged };
}

/** Mark a heartbeat monitor down because no call arrived before the deadline. */
export async function markHeartbeatMissed(
  env: Env,
  monitor: MonitorRecord,
  now: number,
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";
  const stateChanged = prevState !== "down";
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);

  const incident = await applyIncidentTransition(
    env,
    monitor,
    { ok: false, at: now, error: "heartbeat_missed" },
    "heartbeat_missed",
  );

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = 'down', state_since = ?, last_checked_at = ?, last_error = 'heartbeat_missed',
       consecutive_failures = ?, consecutive_successes = 0, next_check_at = ?,
       active_incident_id = ?, is_flapping = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      stateSince,
      now,
      (cur?.consecutive_failures ?? 0) + 1,
      now + monitor.intervalSeconds * 1000,
      incident.activeIncidentId,
      incident.isFlapping ? 1 : 0,
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
    await safe("interval", () =>
      updateStatusInterval(env, monitor.id, "down", now, { ok: false, reason: "heartbeat_missed" }),
    );
  }

  return { prevState, stateChanged };
}
