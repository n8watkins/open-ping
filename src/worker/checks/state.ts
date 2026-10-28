import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { CheckOutcome } from "./types";
import { DOWNTIME_STATES, type MonitorState } from "../../shared/states";
import { newId } from "../lib/ids";
import { nextCheckAt, nextActivePeriod } from "../lib/schedule";
import {
  activeIncidentStatement,
  observationStatement,
  openIncidentStatements,
  recentIncidentCountStatement,
  resolveIncidentByIdStatements,
  resolveIncidentStatements,
  rowToIncident,
  type IncidentRecord,
  type IncidentRow,
} from "../db/incidents";
import { intervalStatements } from "../db/intervals";
import { checkSampleStatement, type CheckSampleTotals } from "../history/rollups";
import {
  ALERT_COOLDOWN_MS,
  COOLDOWN_EVENTS,
  incidentDeliveries,
  recentAlertsStatement,
  type NotifyContext,
} from "../notifications/enqueue";
import { enqueueStatements, type NewOutboxEntry } from "../db/outbox";
import { channelsFromRows, listChannelsStatement } from "../db/channels";
import { activeSubscriptionIdsStatement } from "../db/push";
import { settingsFromRows, settingsStatement, type SettingRow } from "../db/settings";
import { batchEach, runWritePlan, type LabeledStatement, type WriteGroup, type WriteUnit } from "../lib/batch";
import type { NotifyEvent } from "../../shared/notifications";

/**
 * Persists check results: mutable current state, recent samples, incident
 * lifecycle, evolving status intervals, and hourly rollups (PRD §11, §17).
 *
 * Every write is planned as statements first and sent in as few D1 round trips
 * as possible. A cron run reaches the database far from where it runs (a round
 * trip measured about 160 ms in production) and the Free plan allows 50 per
 * run, so the scheduler gathers every monitor's plan and sends them all in one
 * batch with its end-of-run work (lib/batch.ts runWritePlan). The reads a plan
 * depends on (the open incident, recent incidents for flap detection, recent
 * alerts for the cooldown, the alert channels) are one shared batch before it,
 * made only when some check may open or resolve an incident.
 *
 * Each monitor's plan is a WriteGroup: its state, sample and incident change
 * land together or not at all, so the state's incident pointer always matches
 * the incidents table; the alert lands only once the incident did; and the
 * rollup and status interval are independent, so a failure in one never
 * prevents the core state and sample write. The single-monitor entry points
 * (applyCheckResult, recordHeartbeat, ...) use the same plans: one read batch
 * when needed, then one write batch.
 */

const FLAP_WINDOW_MS = 60 * 60 * 1000;
const FLAP_THRESHOLD = 3;
// Each overdue heartbeat cycle credits one cron period (~12 min) of downtime, so
// an ongoing heartbeat outage accrues in the uptime rollups instead of leaving
// the monitor stuck at ~100% uptime.
const HEARTBEAT_DOWN_SLICE_SECONDS = 12 * 60;

/** The monitor_state columns the check path reads; the scheduler preloads them. */
export const STATE_COLUMNS = `state, state_since, last_success_at, last_beat_at, last_error,
            consecutive_failures, consecutive_successes, active_incident_id, is_flapping,
            domain_cache`;

export interface StateRow {
  state: MonitorState;
  state_since: number | null;
  last_success_at: number | null;
  last_beat_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  active_incident_id: string | null;
  is_flapping: number;
  /** A domain monitor's cached RDAP read (checks/domain.ts parseDomainCache). */
  domain_cache: string | null;
}

export async function readState(env: Env, monitorId: string): Promise<StateRow | null> {
  return env.DB.prepare(`SELECT ${STATE_COLUMNS} FROM monitor_state WHERE monitor_id = ?`)
    .bind(monitorId)
    .first<StateRow>();
}

interface SampleInput {
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
}


function sampleStatement(env: Env, monitorId: string, s: SampleInput): D1PreparedStatement {
  return env.DB.prepare(
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
    );
}

// ---------------------------------------------------------------------------
// Reads a plan depends on, batched for every monitor at once.
// ---------------------------------------------------------------------------

/** What one monitor's incident bookkeeping reads before it can be planned. */
export interface IncidentContext {
  /** The monitor's open incident, if any. */
  active: IncidentRecord | null;
  /** Incidents started within the flap window (flap detection). */
  recentIncidents: number;
  /** Down-family alerts already queued within the cooldown window. */
  recentAlerts: ReadonlySet<string>;
}

export interface WriteContext {
  /** Per monitor; absent when its reads failed, and then its incidents are left alone. */
  incidents: ReadonlyMap<string, IncidentContext>;
  /** Fresh state rows (null: no row); absent when not asked for or the read failed. */
  states: ReadonlyMap<string, StateRow | null>;
  /** The alert fan-out's inputs; null when they couldn't be read (no alert is queued). */
  notify: NotifyContext | null;
}

export const EMPTY_WRITE_CONTEXT: WriteContext = { incidents: new Map(), states: new Map(), notify: null };

/** One monitor whose incident may change, and when (the flap window counts back from it). */
export interface IncidentNeed {
  monitorId: string;
  at: number;
}

const NOTIFY_SETTINGS = ["app_url", "vapid_public_key"] as const;

/**
 * Read everything the given plans depend on in one D1 round trip (none when
 * nothing is needed): each monitor's open incident, its recent incidents and
 * recent alerts, fresh state rows (`states`, for the missed-heartbeat freshness
 * re-check), and the alert channels once any incident may change.
 *
 * The statements are independent, so a failed batch is retried one by one
 * (lib/batch.ts batchEach), and a read that still fails degrades as the
 * one-query-at-a-time code did: the cooldown fails open, the flap count reads
 * zero, and a monitor whose open incident can't be read keeps its incident
 * pointer untouched for this cycle.
 */
export async function readWriteContext(
  env: Env,
  needs: { incidents?: IncidentNeed[]; states?: string[] },
  opts: { canSpend?: () => boolean } = {},
): Promise<WriteContext> {
  const incidentNeeds = needs.incidents ?? [];
  const stateIds = needs.states ?? [];
  if (incidentNeeds.length === 0 && stateIds.length === 0) return EMPTY_WRITE_CONTEXT;

  const stmts: LabeledStatement[] = [];
  for (const id of stateIds) {
    stmts.push({
      label: `state ${id}`,
      stmt: env.DB.prepare(`SELECT ${STATE_COLUMNS} FROM monitor_state WHERE monitor_id = ?`).bind(id),
    });
  }
  const alertsSince = Date.now() - ALERT_COOLDOWN_MS;
  for (const n of incidentNeeds) {
    stmts.push(
      { label: `open incident ${n.monitorId}`, stmt: activeIncidentStatement(env, n.monitorId) },
      {
        label: `recent incidents ${n.monitorId}`,
        stmt: recentIncidentCountStatement(env, n.monitorId, n.at - FLAP_WINDOW_MS),
      },
      { label: `recent alerts ${n.monitorId}`, stmt: recentAlertsStatement(env, n.monitorId, alertsSince) },
    );
  }
  if (incidentNeeds.length > 0) {
    stmts.push(
      { label: "channels", stmt: listChannelsStatement(env) },
      { label: "push devices", stmt: activeSubscriptionIdsStatement(env) },
      { label: "notify settings", stmt: settingsStatement(env, NOTIFY_SETTINGS) },
    );
  }

  const results = await batchEach(env, "state", stmts, opts);
  const rows = (i: number): unknown[] | null => results[i]?.results ?? (results[i] ? [] : null);

  let i = 0;
  const states = new Map<string, StateRow | null>();
  for (const id of stateIds) {
    const r = rows(i++);
    if (r) states.set(id, (r[0] as StateRow | undefined) ?? null);
  }
  const incidents = new Map<string, IncidentContext>();
  for (const n of incidentNeeds) {
    const active = rows(i++);
    const recent = rows(i++);
    const alerts = rows(i++);
    if (!active) continue;
    const activeRow = active[0] as IncidentRow | undefined;
    incidents.set(n.monitorId, {
      active: activeRow ? rowToIncident(activeRow) : null,
      recentIncidents: Number((recent?.[0] as { c?: number } | undefined)?.c ?? 0),
      // A failed read fails open: the alert goes out (never lost to a DB blip).
      recentAlerts: new Set((alerts ?? []).map((r) => (r as { event_type: string }).event_type)),
    });
  }

  let notify: NotifyContext | null = null;
  if (incidentNeeds.length > 0) {
    const channelRows = rows(i);
    const pushRows = rows(i + 1);
    const settingRows = rows(i + 2);
    if (channelRows) {
      try {
        const settings = await settingsFromRows(
          env,
          NOTIFY_SETTINGS,
          (settingRows ?? []) as (SettingRow & { key: string })[],
        );
        const vapid = !!(env.VAPID_PUBLIC_KEY ?? settings.get("vapid_public_key"));
        notify = {
          channels: await channelsFromRows(env, channelRows),
          appUrl: env.APP_URL ?? settings.get("app_url") ?? undefined,
          pushIds: vapid ? (pushRows ?? []).map((r) => (r as { id: string }).id) : [],
        };
      } catch (e) {
        console.error("[state] reading the alert channels failed", e);
      }
    }
  }
  return { incidents, states, notify };
}

/**
 * True when a check's outcome may open, observe or resolve an incident, so its
 * plan needs {@link readWriteContext}. A warm-up never touches incidents, and a
 * passing check on a monitor with no open incident has nothing to resolve (the
 * common case, and why a run of passing checks reads nothing more).
 */
export function checkNeedsIncident(outcome: CheckOutcome, cur: StateRow | null): boolean {
  if (outcome.state === "warming_up") return false;
  return !(outcome.ok && cur && !cur.active_incident_id);
}

// ---------------------------------------------------------------------------
// Plans: each monitor's writes as one WriteGroup (lib/batch.ts).
// ---------------------------------------------------------------------------

interface IncidentPlan {
  activeIncidentId: string | null;
  isFlapping: boolean;
  statements: D1PreparedStatement[];
  deliveries: NewOutboxEntry[];
}

/**
 * Open/observe/resolve the active incident for a failed/recovered check, from
 * the batched reads. Returns the incident pointer and flapping flag to store on
 * monitor_state with the statements that make them true, or null when the
 * monitor's incident couldn't be read (its incidents are then left alone).
 */
function planIncidentTransition(
  env: Env,
  monitor: MonitorRecord,
  p: {
    ok: boolean;
    at: number;
    error?: string | null;
    httpStatus?: number | null;
    /** A second check agreed before this failure was reported. */
    confirmed?: boolean;
  },
  ctx: WriteContext,
  downEvent: NotifyEvent = "down",
): IncidentPlan | null {
  const inc = ctx.incidents.get(monitor.id);
  if (!inc) return null;
  const active = inc.active;
  if (!p.ok) {
    if (active) {
      return {
        activeIncidentId: active.id,
        isFlapping: active.isFlapping,
        statements: [observationStatement(env, active.id, { at: p.at, error: p.error, httpStatus: p.httpStatus })],
        deliveries: [],
      };
    }
    // Opening a new incident - flag flapping if too many recently.
    const flapping = inc.recentIncidents + 1 >= FLAP_THRESHOLD;
    const opened = openIncidentStatements(env, monitor, {
      at: p.at,
      error: p.error,
      httpStatus: p.httpStatus,
      isFlapping: flapping,
      confirmed: p.confirmed ?? false,
    });
    // Single flapping warning instead of yet another down alert, and none at all
    // when one of the same type went out for this monitor within the cooldown
    // (notifications/enqueue.ts), so flapping/down storms coalesce.
    const event: NotifyEvent = flapping ? "flapping" : downEvent;
    const coolingDown = COOLDOWN_EVENTS.has(event) && inc.recentAlerts.has(event);
    return {
      activeIncidentId: opened.record.id,
      isFlapping: flapping,
      statements: opened.statements,
      deliveries:
        ctx.notify && !coolingDown ? incidentDeliveries(monitor, opened.record, event, ctx.notify) : [],
    };
  }
  if (!active) return { activeIncidentId: null, isFlapping: false, statements: [], deliveries: [] };
  const resolved = resolveIncidentStatements(env, active, { at: p.at });
  // Suppress the per-incident recovery alert while flapping - a single flapping
  // notification already fired when the incident opened, so rapid flaps don't
  // spam paired down/recovered messages (PRD §14).
  return {
    activeIncidentId: null,
    isFlapping: false,
    statements: resolved.statements,
    deliveries:
      ctx.notify && !active.isFlapping ? incidentDeliveries(monitor, resolved.record, "recovered", ctx.notify) : [],
  };
}

const unit = (label: string, statements: D1PreparedStatement[]): WriteUnit => ({ label, statements });

/**
 * Assemble a monitor's group. `state(withIncident)` builds its monitor_state
 * update, with or without the incident pointer columns: the core writes the
 * pointer with the incident change; the fallbacks, used only when the core
 * can't land, leave both alone (state and sample, then the state alone).
 */
async function assembleGroup(
  env: Env,
  label: string,
  parts: {
    state: (withIncident: boolean) => D1PreparedStatement;
    sample?: D1PreparedStatement | null;
    incident: IncidentPlan | null;
    extras?: WriteUnit[];
  },
): Promise<WriteGroup> {
  const sample = parts.sample ? [parts.sample] : [];
  const incident = parts.incident;
  const core = unit(`${label}: state`, [
    ...(incident?.statements ?? []),
    parts.state(incident !== null),
    ...sample,
  ]);
  const deliveries = incident?.deliveries ?? [];
  const afterCore = deliveries.length ? [unit(`${label}: alert`, await enqueueStatements(env, deliveries))] : [];
  const bare = parts.state(false);
  const fallbacks =
    incident?.statements.length || sample.length
      ? [
          ...(incident?.statements.length && sample.length ? [unit(`${label}: state without incident`, [bare, ...sample])] : []),
          unit(`${label}: state alone`, [bare]),
        ]
      : [];
  return { label, core, afterCore, fallbacks, extras: (parts.extras ?? []).filter((u) => u.statements.length) };
}

export interface PlannedWrite {
  group: WriteGroup;
  prevState: MonitorState;
  stateChanged: boolean;
}

/** Plan an HTTP/DNS/TCP/domain check outcome: state, sample, incident, interval, rollup. */
export async function planCheckResult(
  env: Env,
  monitor: MonitorRecord,
  outcome: CheckOutcome,
  cur: StateRow | null,
  ctx: WriteContext,
): Promise<PlannedWrite> {
  const now = outcome.at;
  const prevState: MonitorState = cur?.state ?? "unknown";
  const stateChanged = prevState !== outcome.state;
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);
  const consecutiveFailures = outcome.ok ? 0 : (cur?.consecutive_failures ?? 0) + 1;
  const consecutiveSuccesses = outcome.ok ? (cur?.consecutive_successes ?? 0) + 1 : 0;
  const lastSuccessAt = outcome.ok ? now : (cur?.last_success_at ?? null);
  const next = nextCheckAt(monitor.schedule, new Date(now), monitor.intervalSeconds).getTime();

  // A failed warm-up cycle does NOT open an incident - it is the one grace cycle
  // a cold start gets. Preserve any existing incident pointer untouched.
  // A passing check on a monitor with no open incident has nothing to resolve.
  const incident: IncidentPlan | null = !checkNeedsIncident(outcome, cur)
    ? {
        activeIncidentId: outcome.state === "warming_up" ? (cur?.active_incident_id ?? null) : null,
        isFlapping: outcome.state === "warming_up" ? cur?.is_flapping === 1 : false,
        statements: [],
        deliveries: [],
      }
    : planIncidentTransition(
        env,
        monitor,
        {
          ok: outcome.ok,
          at: now,
          error: outcome.error,
          httpStatus: outcome.statusCode,
          confirmed: outcome.confirmation === "confirmed",
        },
        ctx,
      );

  const state = (withIncident: boolean) =>
    env.DB.prepare(
      `UPDATE monitor_state SET
         state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
         last_duration_ms = ?, last_status_code = ?, last_error = ?,
         consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
         warmup = ?, ${withIncident ? "active_incident_id = ?, is_flapping = ?," : ""}
         domain_cache = COALESCE(?, domain_cache), updated_at = ?
       WHERE monitor_id = ?`,
    ).bind(
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
      ...(withIncident ? [incident?.activeIncidentId ?? null, incident?.isFlapping ? 1 : 0] : []),
      // A domain check's new cached read; NULL keeps the stored one.
      outcome.domainCache ? JSON.stringify(outcome.domainCache) : null,
      now,
      monitor.id,
    );

  // Merge executor-supplied meta (resolved DNS records, domain expiry, …) with
  // any assertion failures so both are persisted on the sample.
  const sampleMeta: Record<string, unknown> = {};
  if (outcome.meta && typeof outcome.meta === "object") {
    Object.assign(sampleMeta, outcome.meta as Record<string, unknown>);
  }
  if (outcome.assertionFailures?.length) {
    sampleMeta.assertionFailures = outcome.assertionFailures;
  }
  // "confirmed" or "cleared" (a blip: the first check failed, the re-check
  // passed, so no incident opened).
  if (outcome.confirmation === "confirmed" || outcome.confirmation === "cleared") {
    sampleMeta.confirmation = outcome.confirmation;
  }

  const sample = sampleStatement(env, monitor.id, {
    at: now,
    ok: outcome.ok,
    state: outcome.state,
    durationMs: outcome.durationMs,
    statusCode: outcome.statusCode,
    error: outcome.error,
    attempts: outcome.attempts,
    warmup: outcome.warmup,
    retryRecovered: outcome.retryRecovered,
    meta: Object.keys(sampleMeta).length ? sampleMeta : undefined,
  });
  // Warm-up cycles are excluded from uptime accounting (like scheduled-off):
  // they neither count as a successful check nor as downtime.
  const rollup: CheckSampleTotals | null =
    outcome.state === "warming_up"
      ? null
      : {
          at: now,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          retryRecovered: outcome.retryRecovered,
          monitoredSeconds: monitor.intervalSeconds,
          // `suspended` is a down-family outage (DOWNTIME_STATES), so it accrues a
          // full interval of downtime exactly like `down`.
          downSeconds: DOWNTIME_STATES.has(outcome.state) ? monitor.intervalSeconds : 0,
        };

  const label = `check ${monitor.id}`;
  const group = await assembleGroup(env, label, {
    state,
    sample,
    incident,
    extras: [
      unit(`${label}: rollup`, rollup ? [checkSampleStatement(env, monitor.id, rollup)] : []),
      unit(
        `${label}: interval`,
        intervalStatements(env, monitor.id, outcome.state, now, { latencyMs: outcome.durationMs, ok: outcome.ok }),
      ),
    ],
  });
  return { group, prevState, stateChanged };
}

/**
 * Plan a monitor entering (or staying in) a state the scheduler sets without a
 * check: outside its schedule window, or in a maintenance window. Any open
 * incident is resolved as the state changes, so its duration reflects only the
 * actively monitored downtime (the gap is excluded from uptime too). It is
 * resolved directly, so no "recovered" alert fires; a real outage still going
 * when monitoring resumes opens a fresh incident.
 */
function planPausedState(
  env: Env,
  monitor: MonitorRecord,
  now: number,
  cur: StateRow | null,
  target: "scheduled_off" | "maintenance",
  nextAt: number,
): WriteGroup {
  const resolve = cur?.active_incident_id ? resolveIncidentByIdStatements(env, cur.active_incident_id, now) : [];
  const label = `${target === "maintenance" ? "maintenance" : "scheduled-off"} ${monitor.id}`;
  const state = (withIncident: boolean) =>
    cur?.state === target
      ? env.DB.prepare(`UPDATE monitor_state SET next_check_at = ?, updated_at = ? WHERE monitor_id = ?`).bind(
          nextAt,
          now,
          monitor.id,
        )
      : env.DB.prepare(
          `UPDATE monitor_state SET state = ?, state_since = ?, next_check_at = ?,
             ${withIncident ? "active_incident_id = NULL, is_flapping = 0," : ""} updated_at = ?
           WHERE monitor_id = ?`,
        ).bind(target, now, nextAt, now, monitor.id);
  return {
    label,
    core: unit(`${label}: state`, [...resolve, state(true)]),
    fallbacks: resolve.length ? [unit(`${label}: state alone`, [state(false)])] : [],
    extras: [
      unit(
        `${label}: interval`,
        intervalStatements(env, monitor.id, target, now, {
          reason: target === "maintenance" ? "maintenance" : "schedule_window",
        }),
      ),
    ],
  };
}

/** Plan marking a monitor outside its schedule window. No sample/incident/rollup. */
export function planScheduledOff(env: Env, monitor: MonitorRecord, now: number, cur: StateRow | null): WriteGroup {
  const np = nextActivePeriod(monitor.schedule, new Date(now));
  // Clamp to `now`: never write a next_check_at in the past. nextActivePeriod
  // can return a window whose start already passed (e.g. an overnight window
  // still open at `now`); a past timestamp would make the due-query re-fire this
  // monitor every tick. The opening-day exclusion fix in isActiveAt keeps the
  // two functions consistent, but this guard is the hard backstop.
  const nextAt = np ? Math.max(np.start.getTime(), now) : now + monitor.intervalSeconds * 1000;
  return planPausedState(env, monitor, now, cur, "scheduled_off", nextAt);
}

/** Plan marking a monitor in a maintenance window. No check/incident; suppresses outages. */
export function planMaintenanceState(env: Env, monitor: MonitorRecord, now: number, cur: StateRow | null): WriteGroup {
  return planPausedState(env, monitor, now, cur, "maintenance", now + monitor.intervalSeconds * 1000);
}

/**
 * Plan one grace cycle for a heartbeat monitor re-entering its schedule window
 * (snapshot state `scheduled_off`, or a never-beaten `unknown` start). The
 * pre-gap last_beat_at is stale - potentially hours or days old - so the first
 * in-window tick would otherwise be instantly overdue and falsely marked missed
 * (opening an incident + firing an alert) the moment monitoring resumes.
 *
 * Re-base the deadline on `now` and mark the monitor `warming_up` (a non-down,
 * uptime-excluded state, mirroring an HTTP cold start). Because the state is no
 * longer scheduled_off/unknown, the scheduler does NOT warm it up again on the
 * next tick - it resumes ordinary overdue detection from the fresh base, so a
 * genuinely missed beat is still caught.
 */
export function planWarmHeartbeat(env: Env, monitor: MonitorRecord, now: number): WriteGroup {
  const deadline = now + (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;
  const label = `heartbeat warm-up ${monitor.id}`;
  return {
    label,
    core: unit(label, [
      env.DB.prepare(
        `UPDATE monitor_state SET
           state = 'warming_up', state_since = ?, last_beat_at = ?, next_check_at = ?,
           warmup = 1, active_incident_id = NULL, is_flapping = 0, updated_at = ?
         WHERE monitor_id = ?`,
      ).bind(now, now, deadline, now, monitor.id),
    ]),
  };
}

/**
 * Plan marking a heartbeat monitor down because no call arrived before the
 * deadline. `cur` must be a fresh read (readWriteContext `states`): null plan
 * when a beat arrived after the scheduler's snapshot.
 */
export async function planHeartbeatMissed(
  env: Env,
  monitor: MonitorRecord,
  now: number,
  cur: StateRow | null,
  ctx: WriteContext,
): Promise<PlannedWrite | null> {
  // Freshness re-check (closes the heartbeat-ingestion vs scheduler race): if a
  // beat arrived after the scheduler snapshotted state and decided this monitor
  // was overdue, last_beat_at is now within interval+grace - so a beat IS
  // arriving. Skip marking it missed and let the ingestion path's state stand;
  // otherwise we'd clobber the real exit_status error and double-count downtime.
  const graceWindowMs = (monitor.intervalSeconds + (monitor.graceSeconds ?? 0)) * 1000;
  if (cur?.last_beat_at != null && now - cur.last_beat_at < graceWindowMs) return null;

  const prevState: MonitorState = cur?.state ?? "unknown";
  const stateChanged = prevState !== "down";
  const stateSince = stateChanged ? now : (cur?.state_since ?? now);

  const incident = planIncidentTransition(
    env,
    monitor,
    { ok: false, at: now, error: "heartbeat_missed" },
    ctx,
    "heartbeat_missed",
  );

  const state = (withIncident: boolean) =>
    env.DB.prepare(
      `UPDATE monitor_state SET
         state = 'down', state_since = ?, last_checked_at = ?, last_error = 'heartbeat_missed',
         consecutive_failures = ?, consecutive_successes = 0, next_check_at = ?,
         ${withIncident ? "active_incident_id = ?, is_flapping = ?," : ""} updated_at = ?
       WHERE monitor_id = ?`,
    ).bind(
      stateSince,
      now,
      (cur?.consecutive_failures ?? 0) + 1,
      now + monitor.intervalSeconds * 1000,
      ...(withIncident ? [incident?.activeIncidentId ?? null, incident?.isFlapping ? 1 : 0] : []),
      now,
      monitor.id,
    );

  const label = `heartbeat ${monitor.id}`;
  const group = await assembleGroup(env, label, {
    state,
    sample: stateChanged
      ? sampleStatement(env, monitor.id, { at: now, ok: false, state: "down", error: "heartbeat_missed", attempts: 1 })
      : null,
    incident,
    extras: [
      unit(
        `${label}: interval`,
        stateChanged ? intervalStatements(env, monitor.id, "down", now, { ok: false, reason: "heartbeat_missed" }) : [],
      ),
      // Accrue downtime on every overdue cycle (not only the transition) so a
      // sustained heartbeat outage drags uptime down instead of reading ~100%.
      unit(`${label}: rollup`, [
        checkSampleStatement(env, monitor.id, {
          at: now,
          ok: false,
          monitoredSeconds: HEARTBEAT_DOWN_SLICE_SECONDS,
          downSeconds: HEARTBEAT_DOWN_SLICE_SECONDS,
        }),
      ]),
    ],
  });
  return { group, prevState, stateChanged };
}

interface HeartbeatPayload {
  at: number;
  durationMs?: number;
  exitStatus?: number;
  message?: string;
  runId?: string;
  metrics?: Record<string, number>;
}

/** Plan a received heartbeat: state up (or down on a failing exit), sample, incident, interval, rollup. */
export async function planHeartbeat(
  env: Env,
  monitor: MonitorRecord,
  payload: HeartbeatPayload,
  cur: StateRow | null,
  ctx: WriteContext,
  opts?: { maintenance?: boolean; scheduledOff?: boolean },
): Promise<PlannedWrite> {
  const now = payload.at;
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

  const incident: IncidentPlan | null = suppressed
    ? {
        activeIncidentId: cur?.active_incident_id ?? null,
        isFlapping: cur?.is_flapping === 1,
        statements: [],
        deliveries: [],
      }
    : planIncidentTransition(env, monitor, { ok, at: now, error }, ctx);

  const stateStmt = (withIncident: boolean) =>
    env.DB.prepare(
      `UPDATE monitor_state SET
         state = ?, state_since = ?, last_checked_at = ?, last_success_at = ?,
         last_beat_at = ?, last_duration_ms = ?, last_error = ?,
         consecutive_failures = ?, consecutive_successes = ?, next_check_at = ?,
         ${withIncident ? "active_incident_id = ?, is_flapping = ?," : ""} updated_at = ?
       WHERE monitor_id = ?`,
    ).bind(
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
      ...(withIncident ? [incident?.activeIncidentId ?? null, incident?.isFlapping ? 1 : 0] : []),
      now,
      monitor.id,
    );

  // Maintenance / off-schedule beats are excluded from uptime accounting.
  // A beat that recovers a *missed-heartbeat* outage must NOT re-credit a full
  // interval of monitored time: markHeartbeatMissed already accrued that
  // wall-clock span (monitored + down) on each overdue cron cycle. Crediting
  // another interval here would overlap those seconds and inflate uptime. (A
  // recovery from a *received* failing beat - exit_status != 0 - is genuinely
  // one interval later, so it still credits a full interval.)
  const recoveringFromMissed = ok && cur?.state === "down" && cur?.last_error === "heartbeat_missed";
  const label = `beat ${monitor.id}`;
  const group = await assembleGroup(env, label, {
    state: stateStmt,
    sample: sampleStatement(env, monitor.id, {
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
    }),
    incident,
    extras: [
      unit(
        `${label}: interval`,
        intervalStatements(env, monitor.id, state, now, { latencyMs: payload.durationMs, ok }),
      ),
      unit(
        `${label}: rollup`,
        suppressed
          ? []
          : [
              checkSampleStatement(env, monitor.id, {
                at: now,
                ok,
                durationMs: payload.durationMs,
                monitoredSeconds: recoveringFromMissed ? 0 : monitor.intervalSeconds,
                downSeconds: ok ? 0 : monitor.intervalSeconds,
              }),
            ],
      ),
    ],
  });
  return { group, prevState, stateChanged };
}

// ---------------------------------------------------------------------------
// Single-monitor entry points: one read batch when needed, then one write batch.
// ---------------------------------------------------------------------------

/** Write one plan, throwing when not even its state could be written (as a failed query used to). */
async function writeOne(env: Env, group: WriteGroup): Promise<void> {
  const { groups } = await runWritePlan(env, "state", [group]);
  if (groups[0] === "none") throw new Error(`[state] ${group.label}: nothing could be written`);
}

/** Apply an HTTP check outcome: state, sample, incident, interval, rollup. */
export async function applyCheckResult(
  env: Env,
  monitor: MonitorRecord,
  outcome: CheckOutcome,
  /** The monitor's state row when the caller already has it (the scheduler preloads them). */
  known?: StateRow | null,
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const cur = known !== undefined ? known : await readState(env, monitor.id);
  const ctx = checkNeedsIncident(outcome, cur)
    ? await readWriteContext(env, { incidents: [{ monitorId: monitor.id, at: outcome.at }] })
    : EMPTY_WRITE_CONTEXT;
  const planned = await planCheckResult(env, monitor, outcome, cur, ctx);
  await writeOne(env, planned.group);
  return { prevState: planned.prevState, stateChanged: planned.stateChanged };
}

/** Mark a monitor outside its schedule window. No sample/incident/rollup. */
export async function setScheduledOff(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  await writeOne(env, planScheduledOff(env, monitor, now, await readState(env, monitor.id)));
}

/** Mark a monitor in a maintenance window. No check/incident; suppresses outages. */
export async function setMaintenanceState(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  await writeOne(env, planMaintenanceState(env, monitor, now, await readState(env, monitor.id)));
}

/** Record a received heartbeat: state up, reset failures, push next deadline. */
export async function recordHeartbeat(
  env: Env,
  monitor: MonitorRecord,
  payload: HeartbeatPayload,
  opts?: { maintenance?: boolean; scheduledOff?: boolean },
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const suppressed = (opts?.maintenance ?? false) || (opts?.scheduledOff ?? false);
  // The state and (unless suppressed) the incident reads in one round trip.
  const ctx = await readWriteContext(env, {
    states: [monitor.id],
    incidents: suppressed ? [] : [{ monitorId: monitor.id, at: payload.at }],
  });
  const cur = ctx.states.has(monitor.id) ? ctx.states.get(monitor.id)! : await readState(env, monitor.id);
  const planned = await planHeartbeat(env, monitor, payload, cur, ctx, opts);
  await writeOne(env, planned.group);
  return { prevState: planned.prevState, stateChanged: planned.stateChanged };
}

/** Grant one grace cycle to a heartbeat monitor re-entering its schedule window (planWarmHeartbeat). */
export async function warmHeartbeat(env: Env, monitor: MonitorRecord, now: number): Promise<void> {
  await writeOne(env, planWarmHeartbeat(env, monitor, now));
}

/** Mark a heartbeat monitor down because no call arrived before the deadline. */
export async function markHeartbeatMissed(
  env: Env,
  monitor: MonitorRecord,
  now: number,
): Promise<{ prevState: MonitorState; stateChanged: boolean }> {
  const ctx = await readWriteContext(env, { states: [monitor.id], incidents: [{ monitorId: monitor.id, at: now }] });
  if (!ctx.states.has(monitor.id)) throw new Error(`[state] could not read ${monitor.id}'s state`);
  const cur = ctx.states.get(monitor.id) ?? null;
  const planned = await planHeartbeatMissed(env, monitor, now, cur, ctx);
  if (!planned) return { prevState: cur?.state ?? "unknown", stateChanged: false };
  await writeOne(env, planned.group);
  return { prevState: planned.prevState, stateChanged: planned.stateChanged };
}
