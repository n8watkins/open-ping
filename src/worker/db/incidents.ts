import type { Env } from "../types";
import type { MonitorRecord } from "./monitors";
import { newId } from "../lib/ids";

/**
 * Incident lifecycle + flapping detection (PRD §11). An incident is opened when
 * a monitor first transitions to `down`, kept alive (`recordObservation`) while
 * it stays down, and resolved on recovery. Each lifecycle transition appends a
 * row to `incident_events` (the public/private timeline); plain observations do
 * NOT add events, to avoid timeline spam. All timestamps are epoch milliseconds
 * (`duration_seconds` is the one exception - whole seconds, per the schema).
 * Booleans (public/is_flapping/notified) are stored as 0/1 integers and mapped
 * to/from a camelCase `IncidentRecord`.
 */

export interface IncidentRecord {
  id: string;
  monitorId: string;
  status: "open" | "resolved";
  title: string | null;
  rootCause: string | null;
  startedAt: number;
  lastObservedAt: number | null;
  resolvedAt: number | null;
  durationSeconds: number | null;
  httpStatus: number | null;
  error: string | null;
  privateNotes: string | null;
  publicMessage: string | null;
  resolution: string | null;
  public: boolean;
  isFlapping: boolean;
  notified: boolean;
  /** A second check confirmed the failure before this incident opened. */
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of an `incidents` row as returned by D1. */
export interface IncidentRow {
  id: string;
  monitor_id: string;
  status: string;
  title: string | null;
  root_cause: string | null;
  started_at: number;
  last_observed_at: number | null;
  resolved_at: number | null;
  duration_seconds: number | null;
  http_status: number | null;
  error: string | null;
  private_notes: string | null;
  public_message: string | null;
  resolution: string | null;
  public: number;
  is_flapping: number;
  notified: number;
  confirmed?: number | null;
  created_at: number;
  updated_at: number;
}

/** Map a raw row to a typed record, coercing 0/1 to booleans. */
export function rowToIncident(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status === "resolved" ? "resolved" : "open",
    title: row.title,
    rootCause: row.root_cause,
    startedAt: row.started_at,
    lastObservedAt: row.last_observed_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    durationSeconds: row.duration_seconds ?? null,
    httpStatus: row.http_status ?? null,
    error: row.error,
    privateNotes: row.private_notes,
    publicMessage: row.public_message,
    resolution: row.resolution,
    public: row.public !== 0,
    isFlapping: row.is_flapping !== 0,
    notified: row.notified !== 0,
    confirmed: row.confirmed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Read a single incident by id (null if missing). */
export async function getIncidentById(
  env: Env,
  id: string,
): Promise<IncidentRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM incidents WHERE id = ?")
    .bind(id)
    .first<IncidentRow>();
  return row ? rowToIncident(row) : null;
}

/** The currently-open incident for a monitor (newest first), or null. */
export async function getActiveIncident(
  env: Env,
  monitorId: string,
): Promise<IncidentRecord | null> {
  const row = await activeIncidentStatement(env, monitorId).first<IncidentRow>();
  return row ? rowToIncident(row) : null;
}

/** The getActiveIncident query, for a caller that batches its reads (rows: IncidentRow). */
export function activeIncidentStatement(env: Env, monitorId: string): D1PreparedStatement {
  return env.DB.prepare(
    "SELECT * FROM incidents WHERE monitor_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1",
  ).bind(monitorId);
}

/**
 * Open a new incident for a down monitor and record the `opened` timeline event.
 * `root_cause` mirrors the machine error code (the category) when present.
 */
export async function openIncident(
  env: Env,
  monitor: MonitorRecord,
  ctx: {
    at: number;
    error?: string | null;
    httpStatus?: number | null;
    isFlapping?: boolean;
    /** A second check agreed before the incident opened. */
    confirmed?: boolean;
  },
): Promise<IncidentRecord> {
  const { record, statements } = openIncidentStatements(env, monitor, ctx);
  await env.DB.batch(statements);
  const created = await getIncidentById(env, record.id);
  if (!created) throw new Error("openIncident: failed to read back inserted row");
  return created;
}

/**
 * The writes that open an incident (the row and its `opened` timeline event),
 * and the record they create, so a caller can batch them with the monitor's
 * state change and build the alert without reading the row back.
 */
export function openIncidentStatements(
  env: Env,
  monitor: Pick<MonitorRecord, "id" | "name">,
  ctx: {
    at: number;
    error?: string | null;
    httpStatus?: number | null;
    isFlapping?: boolean;
    confirmed?: boolean;
  },
): { record: IncidentRecord; statements: D1PreparedStatement[] } {
  const id = newId("inc");
  const at = ctx.at;
  const error = ctx.error ?? null;
  const httpStatus = ctx.httpStatus ?? null;
  const title = `${monitor.name} is down`;
  const record: IncidentRecord = {
    id,
    monitorId: monitor.id,
    status: "open",
    title,
    rootCause: error,
    startedAt: at,
    lastObservedAt: at,
    resolvedAt: null,
    durationSeconds: null,
    httpStatus,
    error,
    privateNotes: null,
    publicMessage: null,
    resolution: null,
    public: false,
    isFlapping: ctx.isFlapping ?? false,
    notified: false,
    confirmed: ctx.confirmed ?? false,
    createdAt: at,
    updatedAt: at,
  };
  return {
    record,
    statements: [
      env.DB.prepare(
        `INSERT INTO incidents (
           id, monitor_id, status, title, root_cause, started_at,
           last_observed_at, http_status, error, public, is_flapping,
           notified, confirmed, created_at, updated_at
         ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
      ).bind(
        id,
        monitor.id,
        title,
        error,
        at,
        at,
        httpStatus,
        error,
        ctx.isFlapping ? 1 : 0,
        ctx.confirmed ? 1 : 0,
        at,
        at,
      ),
      env.DB.prepare(
        `INSERT INTO incident_events (id, incident_id, at, kind, message)
         VALUES (?, ?, ?, 'opened', ?)`,
      ).bind(newId("iev"), id, at, title),
    ],
  };
}

/**
 * Refresh an open incident with the latest down observation. Updates the
 * last-observed timestamp / error / http status only - no timeline event, so a
 * long outage does not produce one event per check.
 */
export async function recordObservation(
  env: Env,
  incidentId: string,
  ctx: { at: number; error?: string | null; httpStatus?: number | null },
): Promise<void> {
  await observationStatement(env, incidentId, ctx).run();
}

/** The recordObservation write, for a caller that batches it. */
export function observationStatement(
  env: Env,
  incidentId: string,
  ctx: { at: number; error?: string | null; httpStatus?: number | null },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE incidents
       SET last_observed_at = ?, error = ?, http_status = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(ctx.at, ctx.error ?? null, ctx.httpStatus ?? null, ctx.at, incidentId);
}

/**
 * The writes that resolve an incident, for a caller that batches them, with the
 * record as it will read afterwards. The same contract as resolveIncident: the
 * update is guarded on `status = 'open'`, so a repeat (or a race with another
 * path) changes nothing, and the `recovered` event is written only when this
 * resolve is the one that closed it (the row now carries this resolve's
 * timestamp, which no earlier resolve can have).
 */
export function resolveIncidentStatements(
  env: Env,
  incident: IncidentRecord,
  ctx: { at: number },
): { record: IncidentRecord; statements: D1PreparedStatement[] } {
  const durationSeconds = Math.round((ctx.at - incident.startedAt) / 1000);
  return {
    record: {
      ...incident,
      status: "resolved",
      resolvedAt: ctx.at,
      durationSeconds,
      updatedAt: ctx.at,
    },
    statements: resolveIncidentByIdStatements(env, incident.id, ctx.at),
  };
}

/**
 * Resolve an open incident by id without reading it first (its duration comes
 * from its own started_at), for a caller that only knows the pointer, such as
 * a monitor entering maintenance or leaving its schedule window. Same guards as
 * resolveIncidentStatements. With `onlyIf`, it resolves only while the
 * monitor's state still matches the snapshot the caller planned from (a write
 * sent later in a batch must not undo one that happened in between).
 */
export function resolveIncidentByIdStatements(
  env: Env,
  incidentId: string,
  at: number,
  /** A condition on the monitor's monitor_state row (`ms`), with its values. */
  onlyIf?: { monitorId: string; sql: string; binds: (string | number | null)[] },
): D1PreparedStatement[] {
  const update = env.DB.prepare(
    `UPDATE incidents
       SET status = 'resolved', resolved_at = ?,
           duration_seconds = CAST(ROUND((? - started_at) / 1000.0) AS INTEGER), updated_at = ?
     WHERE id = ? AND status = 'open'${
       onlyIf ? " AND EXISTS (SELECT 1 FROM monitor_state ms WHERE ms.monitor_id = ? AND " + onlyIf.sql + ")" : ""
     }`,
  ).bind(at, at, at, incidentId, ...(onlyIf ? [onlyIf.monitorId, ...onlyIf.binds] : []));
  return [
    update,
    env.DB.prepare(
      `INSERT INTO incident_events (id, incident_id, at, kind, message)
       SELECT ?1, ?2, ?3, 'recovered', 'Recovered'
        WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ?2 AND status = 'resolved' AND resolved_at = ?3)`,
    ).bind(newId("iev"), incidentId, at),
  ];
}

/**
 * Resolve an incident on recovery: stamp `resolved_at`, compute the duration in
 * whole seconds, and append a `recovered` timeline event. Idempotent - only the
 * open → resolved transition mutates the row and writes the event, so a repeat
 * resolve is a no-op. Returns the (resolved) record, or null if no such incident
 * exists.
 */
export async function resolveIncident(
  env: Env,
  incidentId: string,
  ctx: { at: number },
): Promise<IncidentRecord | null> {
  const existing = await getIncidentById(env, incidentId);
  if (!existing) return null;

  const durationSeconds = Math.round((ctx.at - existing.startedAt) / 1000);

  // Guard on `status = 'open'` so only the first resolve transitions the row.
  // A double-resolve (e.g. the unlocked heartbeat route racing the scheduler)
  // matches zero rows here and becomes a no-op - resolved_at/duration stay put
  // and no second `recovered` timeline event is written.
  const res = await env.DB.prepare(
    `UPDATE incidents
       SET status = 'resolved', resolved_at = ?, duration_seconds = ?,
           updated_at = ?
     WHERE id = ? AND status = 'open'`,
  )
    .bind(ctx.at, durationSeconds, ctx.at, incidentId)
    .run();

  // Only append the recovery event when this call actually closed the incident.
  if (res.meta?.changes === 1) {
    await env.DB.prepare(
      `INSERT INTO incident_events (id, incident_id, at, kind, message)
       VALUES (?, ?, ?, 'recovered', ?)`,
    )
      .bind(newId("iev"), incidentId, ctx.at, "Recovered")
      .run();
  }

  return getIncidentById(env, incidentId);
}

/** Count incidents for a monitor that started at/after `sinceMs`. */
export async function countRecentIncidents(
  env: Env,
  monitorId: string,
  sinceMs: number,
): Promise<number> {
  const row = await recentIncidentCountStatement(env, monitorId, sinceMs).first<{ c: number }>();
  return row?.c ?? 0;
}

/** The countRecentIncidents query, for a caller that batches its reads (row: `{ c }`). */
export function recentIncidentCountStatement(env: Env, monitorId: string, sinceMs: number): D1PreparedStatement {
  return env.DB.prepare(
    "SELECT COUNT(*) AS c FROM incidents WHERE monitor_id = ? AND started_at >= ?",
  ).bind(monitorId, sinceMs);
}
