import { z } from "zod";
import type { Env } from "../types";
import { newId } from "../lib/ids";
import {
  INCIDENT_UPDATE_STATUSES,
  type IncidentUpdateStatus,
} from "../../shared/incident-updates";
import { IN_JSON_LIST, jsonList } from "./sql-list";

/**
 * Incident updates: the timeline of status posts an admin writes for an
 * incident (migration 0013). Each update has a status (Investigating,
 * Identified, Monitoring, Resolved) and a free-text message. They are public
 * copy by design, but appear publicly only while their incident is public
 * (routes/public.ts and routes/feeds.ts enforce that).
 *
 * An update describes the incident; it never changes it. Posting "Resolved"
 * does not close the incident: the scheduler resolves incidents when the
 * monitor recovers, and the admin may want to say "Resolved" first.
 *
 * `incidents.public_message` stays the incident's one-line summary, shown
 * above the timeline, so nothing existing is migrated or reinterpreted.
 */

export {
  INCIDENT_UPDATE_LABELS,
  INCIDENT_UPDATE_STATUSES,
  type IncidentUpdateStatus,
} from "../../shared/incident-updates";

/** Most updates one incident may hold, so a script can't grow it without bound. */
export const MAX_UPDATES_PER_INCIDENT = 100;
/** Longest update message, matching the other incident text fields. */
export const MAX_UPDATE_MESSAGE = 2000;

const statusSchema = z.enum(INCIDENT_UPDATE_STATUSES);
const messageSchema = z
  .string()
  .trim()
  .min(1, "Write a message for this update.")
  .max(MAX_UPDATE_MESSAGE, `Keep it under ${MAX_UPDATE_MESSAGE} characters.`);

/** Body of POST /api/incidents/:id/updates (and the MCP/CLI equivalents). */
export const createUpdateSchema = z.object({
  status: statusSchema,
  message: messageSchema,
});

/** Body of PATCH /api/incidents/:id/updates/:updateId: change either or both. */
export const editUpdateSchema = z
  .object({ status: statusSchema.optional(), message: messageSchema.optional() })
  .refine((v) => v.status !== undefined || v.message !== undefined, {
    message: "Give a status or a message to change.",
  });

export interface IncidentUpdate {
  id: string;
  incidentId: string;
  status: IncidentUpdateStatus;
  message: string;
  postedAt: number;
  createdAt: number;
  updatedAt: number;
}

interface IncidentUpdateRow {
  id: string;
  incident_id: string;
  status: string;
  message: string;
  posted_at: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = "id, incident_id, status, message, posted_at, created_at, updated_at";

function rowToUpdate(row: IncidentUpdateRow): IncidentUpdate {
  return {
    id: row.id,
    incidentId: row.incident_id,
    // The CHECK constraint guarantees one of the four values.
    status: row.status as IncidentUpdateStatus,
    message: row.message,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Newest first, the order every surface shows them in. */
function newestFirst(a: IncidentUpdate, b: IncidentUpdate): number {
  return b.postedAt - a.postedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

/** One incident's updates, newest first. */
export async function listIncidentUpdates(env: Env, incidentId: string): Promise<IncidentUpdate[]> {
  const res = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM incident_updates WHERE incident_id = ? ORDER BY posted_at DESC, created_at DESC, id DESC`,
  )
    .bind(incidentId)
    .all<IncidentUpdateRow>();
  return (res.results ?? []).map(rowToUpdate);
}

/**
 * The updates of several incidents in one query, grouped by incident id and
 * newest first. Every id in `incidentIds` gets an entry (empty when it has none).
 */
export async function updatesForIncidents(
  env: Env,
  incidentIds: readonly string[],
): Promise<Map<string, IncidentUpdate[]>> {
  const out = new Map<string, IncidentUpdate[]>(incidentIds.map((id) => [id, []]));
  if (incidentIds.length === 0) return out;
  const unique = [...new Set(incidentIds)];
  const res = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM incident_updates WHERE incident_id ${IN_JSON_LIST}`,
  )
    .bind(jsonList(unique))
    .all<IncidentUpdateRow>();
  for (const row of res.results ?? []) out.get(row.incident_id)?.push(rowToUpdate(row));
  for (const list of out.values()) list.sort(newestFirst);
  return out;
}

export type CreateUpdateResult =
  | { ok: true; update: IncidentUpdate }
  | { ok: false; error: "not_found" | "too_many_updates" };

/**
 * Post an update to an incident, stamped now. Fails with `not_found` when the
 * incident doesn't exist and `too_many_updates` at {@link MAX_UPDATES_PER_INCIDENT}.
 */
export async function createIncidentUpdate(
  env: Env,
  incidentId: string,
  input: z.infer<typeof createUpdateSchema>,
  now: number = Date.now(),
): Promise<CreateUpdateResult> {
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM incident_updates WHERE incident_id = ?1) AS n FROM incidents WHERE id = ?1",
  )
    .bind(incidentId)
    .first<{ n: number }>();
  if (!row) return { ok: false, error: "not_found" };
  if (row.n >= MAX_UPDATES_PER_INCIDENT) return { ok: false, error: "too_many_updates" };

  const update: IncidentUpdate = {
    id: newId("iup"),
    incidentId,
    status: input.status,
    message: input.message,
    postedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO incident_updates (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(update.id, incidentId, update.status, update.message, now, now, now),
    // The incident changed as far as its readers are concerned (feeds use it).
    env.DB.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").bind(now, incidentId),
  ]);
  return { ok: true, update };
}

/** Change an update's status and/or message; null when no such update on that incident. */
export async function editIncidentUpdate(
  env: Env,
  incidentId: string,
  updateId: string,
  patch: z.infer<typeof editUpdateSchema>,
  now: number = Date.now(),
): Promise<IncidentUpdate | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.message !== undefined) {
    sets.push("message = ?");
    binds.push(patch.message);
  }
  sets.push("updated_at = ?");
  binds.push(now);
  const row = await env.DB.prepare(
    `UPDATE incident_updates SET ${sets.join(", ")} WHERE id = ? AND incident_id = ? RETURNING ${COLUMNS}`,
  )
    .bind(...binds, updateId, incidentId)
    .first<IncidentUpdateRow>();
  if (!row) return null;
  await env.DB.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").bind(now, incidentId).run();
  return rowToUpdate(row);
}

/** Delete one update; false when no such update on that incident. */
export async function deleteIncidentUpdate(
  env: Env,
  incidentId: string,
  updateId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM incident_updates WHERE id = ? AND incident_id = ?")
    .bind(updateId, incidentId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return false;
  await env.DB.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").bind(now, incidentId).run();
  return true;
}
