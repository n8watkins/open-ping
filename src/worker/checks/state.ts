import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { CheckOutcome } from "./types";
import { DOWNTIME_STATES, type MonitorState } from "../../shared/states";
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
// Each overdue heartbeat cycle credits one cron period (~12 min) of downtime, so
// an ongoing heartbeat outage accrues in the uptime rollups instead of leaving
// the monitor stuck at ~100% uptime.
const HEARTBEAT_DOWN_SLICE_SECONDS = 12 * 60;

interface StateRow {
  state: MonitorState;
  state_since: number | null;
  last_success_at: number | null;
  last_beat_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  active_incident_id: string | null;
  is_flapping: number;
}

async function readState(env: Env, monitorId: string): Promise<StateRow | null> {
  return env.DB.prepare(
    `SELECT state, state_since, last_success_at, last_beat_at, last_error,
            consecutive_failures, consecutive_successes, active_incident_id, is_flapping
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
      // Suppress the per-incident recovery alert while flapping — a single
      // flapping notification already fired when the incident opened, so rapid
      // flaps don't spam paired down/recovered messages (PRD §14).
      if (!active.isFlapping) {
        await safe("notify", () =>
          enqueueIncidentEvent(env, monitor, resolved ?? active, "recovered"),
        );
      }
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

  // A failed warm-up cycle does NOT open an incident — it is the one grace cycle
  // a cold start gets. Preserve any existing incident pointer untouched.
  const incident =
    outcome.state === "warming_up"
      ? {
          activeIncidentId: cur?.active_incident_id ?? null,
          isFlapping: cur?.is_flapping === 1,
        }
      : await applyIncidentTransition(env, monitor, {
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
  // Warm-up cycles are excluded from uptime accounting (like scheduled-off):
  // they neither count as a successful check nor as downtime.
  if (outcome.state !== "warming_up") {
    await safe("rollup", () =>
      recordCheckSample(env, monitor.id, {
        at: now,
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        retryRecovered: outcome.retryRecovered,
        monitoredSeconds: monitor.intervalSeconds,
        // `suspended` is a down-family outage (DOWNTIME_STATES), so it accrues a
        // full interval of downtime exactly like `down`.
        downSeconds: DOWNTIME_STATES.has(outcome.state) ? monitor.intervalSeconds : 0,
      }),
    );
  }

  return { prevState, stateChanged };
}

/** Mark a monitor outside its schedule window. No sample/incident/rollup. */
export async function setScheduledOff(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  const cur = await readState(env, monitor.id);
  const np = nextActivePeriod(monitor.schedule, new Date(now));
  // Clamp to `now`: never write a next_check_at in the past. nextActivePeriod
  // can return a window whose start already passed (e.g. an overnight window
  // still open at `now`); a past timestamp would make the due-query re-fire this
  // monitor every tick. The opening-day exclusion fix in isActiveAt keeps the
  // two functions consistent, but this guard is the hard backstop.
  const nextAt = np ? Math.max(np.start.getTime(), now) : now + monitor.intervalSeconds * 1000;

  // Resolve any open incident at the moment monitoring pauses so its
  // duration_seconds reflects only the actively-monitored downtime, not the
  // un-monitored off-hours gap (which uptime accounting also excludes). Called
  // directly (not via applyIncidentTransition), so no "recovered" alert fires.
  if (cur?.active_incident_id) {
    await safe("incident-resolve", () =>
      resolveIncident(env, cur.active_incident_id!, { at: now }).then(() => {}),
    );
  }

  if (cur?.state === "scheduled_off") {
    await env.DB.prepare(`UPDATE monitor_state SET next_check_at = ?, updated_at = ? WHERE monitor_id = ?`)
      .bind(nextAt, now, monitor.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE monitor_state SET state = 'scheduled_off', state_since = ?, next_check_at = ?,
         active_incident_id = NULL, is_flapping = 0, updated_at = ?
       WHERE monitor_id = ?`,
    )
      .bind(now, nextAt, now, monitor.id)
      .run();
  }
  await safe("interval", () =>
    updateStatusInterval(env, monitor.id, "scheduled_off", now, { reason: "schedule_window" }),
  );
}

/** Mark a monitor in a maintenance window. No check/incident; suppresses outages. */
export async function setMaintenanceState(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  const cur = await readState(env, monitor.id);
  const next = now + monitor.intervalSeconds * 1000;

  // Resolve any open incident when a maintenance window starts so its duration
  // doesn't span the (incident-suppressed, uptime-excluded) maintenance gap. A
  // real outage still ongoing when maintenance ends reopens a fresh incident.
  if (cur?.active_incident_id) {
    await safe("incident-resolve", () =>
      resolveIncident(env, cur.active_incident_id!, { at: now }).then(() => {}),
    );
  }

  if (cur?.state === "maintenance") {
    await env.DB.prepare(`UPDATE monitor_state SET next_check_at = ?, updated_at = ? WHERE monitor_id = ?`)
      .bind(next, now, monitor.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE monitor_state SET state = 'maintenance', state_since = ?, next_check_at = ?,
         active_incident_id = NULL, is_flapping = 0, updated_at = ?
       WHERE monitor_id = ?`,
    )
      .bind(now, next, now, monitor.id)
      .run();
  }
  await safe("interval", () =>
    updateStatusInterval(env, monitor.id, "maintenance", now, { reason: "maintenance" }),
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
  opts?: { maintenance?: boolean; scheduledOff?: boolean },
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const now = payload.at;
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";
  const ok = payload.exitStatus == null || payload.exitStatus === 0;
  // A beat received during a maintenance window OR outside the monitor's
  // schedule window is still recorded (state + last_beat_at, so deadline
  // tracking stays sane), but its failure must NOT open an incident or fire an
  // alert, and the cycle is excluded from uptime accounting (PRD §16/§11/§7).
  // Maintenance takes precedence over schedule for the displayed state.
  const inMaintenance = opts?.maintenance ?? false;
  const offSchedule = (opts?.scheduledOff ?? false) && !inMaintenance;
  const suppressed = inMaintenance || offSchedule;
  const state: MonitorState = inMaintenance
    ? "maintenance"
    : offSchedule
      ? "scheduled_off"
      : ok
        ? "up"
        : "down";
  const stateChanged = prevState !== state;
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);
  const deadline = now + (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;
  const error = ok ? null : `exit_status_${payload.exitStatus}`;

  const incident = suppressed
    ? {
        activeIncidentId: cur?.active_incident_id ?? null,
        isFlapping: cur?.is_flapping === 1,
      }
    : await applyIncidentTransition(env, monitor, { ok, at: now, error });

  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
       last_beat_at = ?, last_duration_ms = ?, last_error = ?,
       consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
       active_incident_id = ?, is_flapping = ?, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(
      state,
      stateSince,
      now,
      ok ? now : (cur?.last_success_at ?? null),
      // last_beat_at advances on EVERY received beat (ok or fail) so the
      // scheduler's overdue test is driven by beats actually arriving.
      now,
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
  // Maintenance / off-schedule beats are excluded from uptime accounting.
  if (!suppressed) {
    // A beat that recovers a *missed-heartbeat* outage must NOT re-credit a full
    // interval of monitored time: markHeartbeatMissed already accrued that
    // wall-clock span (monitored + down) on each overdue cron cycle. Crediting
    // another interval here would overlap those seconds and inflate uptime. (A
    // recovery from a *received* failing beat — exit_status != 0 — is genuinely
    // one interval later, so it still credits a full interval.)
    const recoveringFromMissed =
      ok && cur?.state === "down" && cur?.last_error === "heartbeat_missed";
    await safe("rollup", () =>
      recordCheckSample(env, monitor.id, {
        at: now,
        ok,
        durationMs: payload.durationMs,
        monitoredSeconds: recoveringFromMissed ? 0 : monitor.intervalSeconds,
        downSeconds: ok ? 0 : monitor.intervalSeconds,
      }),
    );
  }

  return { prevState, stateChanged };
}

/**
 * Grant one grace cycle to a heartbeat monitor re-entering its schedule window
 * (snapshot state `scheduled_off`, or a never-beaten `unknown` start). The
 * pre-gap last_beat_at is stale — potentially hours or days old — so the first
 * in-window tick would otherwise be instantly overdue and falsely marked missed
 * (opening an incident + firing an alert) the moment monitoring resumes.
 *
 * Re-base the deadline on `now` and mark the monitor `warming_up` (a non-down,
 * uptime-excluded state, mirroring an HTTP cold start). Because the state is no
 * longer scheduled_off/unknown, the scheduler does NOT warm it up again on the
 * next tick — it resumes ordinary overdue detection from the fresh base, so a
 * genuinely missed beat is still caught.
 */
export async function warmHeartbeat(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  const deadline = now + (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;
  await env.DB.prepare(
    `UPDATE monitor_state SET
       state = 'warming_up', state_since = ?, last_beat_at = ?, next_check_at = ?,
       warmup = 1, active_incident_id = NULL, is_flapping = 0, updated_at = ?
     WHERE monitor_id = ?`,
  )
    .bind(now, now, deadline, now, monitor.id)
    .run();
}

/** Mark a heartbeat monitor down because no call arrived before the deadline. */
export async function markHeartbeatMissed(
  env: Env,
  monitor: MonitorRecord,
  now: number,
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const cur = await readState(env, monitor.id);
  const prevState: MonitorState = cur?.state ?? "unknown";

  // Freshness re-check (closes the heartbeat-ingestion vs scheduler race): if a
  // beat arrived after the scheduler snapshotted state and decided this monitor
  // was overdue, last_beat_at is now within interval+grace — so a beat IS
  // arriving. Skip marking it missed and let the ingestion path's state stand;
  // otherwise we'd clobber the real exit_status error and double-count downtime.
  const graceWindowMs =
    (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;
  if (cur?.last_beat_at != null && now - cur.last_beat_at < graceWindowMs) {
    return { prevState, stateChanged: false };
  }

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

  // Accrue downtime on every overdue cycle (not only the transition) so a
  // sustained heartbeat outage drags uptime down instead of reading ~100%.
  await safe("rollup", () =>
    recordCheckSample(env, monitor.id, {
      at: now,
      ok: false,
      monitoredSeconds: HEARTBEAT_DOWN_SLICE_SECONDS,
      downSeconds: HEARTBEAT_DOWN_SLICE_SECONDS,
    }),
  );

  return { prevState, stateChanged };
}
