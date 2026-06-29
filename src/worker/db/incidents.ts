import type { Env } from "../types";
import type { MonitorRecord } from "./monitors";
import { newId } from "../lib/ids";

/**
 * Incident lifecycle + flapping detection (PRD §11). An incident is opened when
 * a monitor first transitions to `down`, kept alive (`recordObservation`) while
 * it stays down, and resolved on recovery. Each lifecycle transition appends a
 * row to `incident_events` (the public/private timeline); plain observations do
 * NOT add events, to avoid timeline spam. All timestamps are epoch milliseconds
 * (`duration_seconds` is the one exception — whole seconds, per the schema).
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
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of an `incidents` row as returned by D1. */
interface IncidentRow {
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
  created_at: number;
  updated_at: number;
}

/** Map a raw row to a typed record, coercing 0/1 to booleans. */
function rowToIncident(row: IncidentRow): IncidentRecord {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Read a single incident by id (internal; null if missing). */
async function getIncidentById(
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
  const row = await env.DB.prepare(
    "SELECT * FROM incidents WHERE monitor_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1",
  )
    .bind(monitorId)
    .first<IncidentRow>();
  return row ? rowToIncident(row) : null;
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
  },
): Promise<IncidentRecord> {
  const id = newId("inc");
  const at = ctx.at;
  const error = ctx.error ?? null;
  const httpStatus = ctx.httpStatus ?? null;
  const title = `${monitor.name} is down`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO incidents (
         id, monitor_id, status, title, root_cause, started_at,
         last_observed_at, http_status, error, public, is_flapping,
         notified, created_at, updated_at
       ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
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
      at,
      at,
    ),
    env.DB.prepare(
      `INSERT INTO incident_events (id, incident_id, at, kind, message)
       VALUES (?, ?, ?, 'opened', ?)`,
    ).bind(newId("iev"), id, at, title),
  ]);

  const created = await getIncidentById(env, id);
  if (!created) throw new Error("openIncident: failed to read back inserted row");
  return created;
}

/**
 * Refresh an open incident with the latest down observation. Updates the
 * last-observed timestamp / error / http status only — no timeline event, so a
 * long outage does not produce one event per check.
 */
export async function recordObservation(
  env: Env,
  incidentId: string,
  ctx: { at: number; error?: string | null; httpStatus?: number | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE incidents
       SET last_observed_at = ?, error = ?, http_status = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(ctx.at, ctx.error ?? null, ctx.httpStatus ?? null, ctx.at, incidentId)
    .run();
}

/**
 * Resolve an incident on recovery: stamp `resolved_at`, compute the duration in
 * whole seconds, and append a `recovered` timeline event. Returns the updated
 * record, or null if no such incident exists.
 */
export async function resolveIncident(
  env: Env,
  incidentId: string,
  ctx: { at: number },
): Promise<IncidentRecord | null> {
  const existing = await getIncidentById(env, incidentId);
  if (!existing) return null;

  const durationSeconds = Math.round((ctx.at - existing.startedAt) / 1000);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE incidents
         SET status = 'resolved', resolved_at = ?, duration_seconds = ?,
             updated_at = ?
       WHERE id = ?`,
    ).bind(ctx.at, durationSeconds, ctx.at, incidentId),
    env.DB.prepare(
      `INSERT INTO incident_events (id, incident_id, at, kind, message)
       VALUES (?, ?, ?, 'recovered', ?)`,
    ).bind(newId("iev"), incidentId, ctx.at, "Recovered"),
  ]);

  return getIncidentById(env, incidentId);
}

/** Mark an incident's "down" notification as sent (idempotency guard). */
export async function markNotified(
  env: Env,
  incidentId: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE incidents SET notified = 1, updated_at = ? WHERE id = ?",
  )
    .bind(Date.now(), incidentId)
    .run();
}

/** Count incidents for a monitor that started at/after `sinceMs`. */
export async function countRecentIncidents(
  env: Env,
  monitorId: string,
  sinceMs: number,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM incidents WHERE monitor_id = ? AND started_at >= ?",
  )
    .bind(monitorId, sinceMs)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Flag/unflag an incident as flapping. */
export async function setFlapping(
  env: Env,
  incidentId: string,
  flapping: boolean,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE incidents SET is_flapping = ?, updated_at = ? WHERE id = ?",
  )
    .bind(flapping ? 1 : 0, Date.now(), incidentId)
    .run();
}

/**
 * Pure flapping test: true when the number of incident start times falling
 * within the trailing window `(now - windowMs, now]` reaches `threshold`.
 * The lower bound is exclusive and the upper bound inclusive.
 */
export function isFlapping(
  incidentStartTimes: number[],
  now: number,
  windowMs = 60 * 60 * 1000,
  threshold = 3,
): boolean {
  const lowerBound = now - windowMs;
  let count = 0;
  for (const t of incidentStartTimes) {
    if (t > lowerBound && t <= now) count++;
  }
  return count >= threshold;
}
