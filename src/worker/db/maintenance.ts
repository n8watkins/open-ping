import type { Env } from "../types";
import { newId } from "../lib/ids";

/**
 * Maintenance-window data layer + activity engine (PRD §16 Maintenance, §11 —
 * an active window suppresses incidents/alerts). The `maintenance_windows` table
 * stores `monitor_ids` and `recurrence` as JSON TEXT; this module maps rows
 * to/from a camelCase `MaintenanceWindow` with parsed objects. Timestamps are
 * epoch milliseconds.
 *
 * Recurrence: only a simple weekly rule is supported in v1. A null recurrence is
 * a one-time window bounded by `startsAt`/`endsAt`.
 *
 * TIME ZONE: all recurrence math is performed in UTC. A weekly rule's `weekday`
 * (0=Sun..6=Sat) and `start` ("HH:MM") are interpreted as UTC wall-clock values.
 */

/** A weekly recurrence rule (the only recurrence type supported in v1). */
export type Recurrence = {
  type: "weekly";
  /** 0 = Sunday .. 6 = Saturday (UTC). */
  weekday: number;
  /** Local-to-UTC start time, "HH:MM" 24h. */
  start: string;
  /** Window length in minutes (may cross midnight / the week boundary). */
  durationMinutes: number;
};

export interface MaintenanceWindow {
  id: string;
  title: string | null;
  scope: "global" | "monitors";
  /** Affected monitor ids when scope === "monitors"; null for global. */
  monitorIds: string[] | null;
  startsAt: number;
  endsAt: number;
  /** Weekly recurrence rule, or null for a one-time window. */
  recurrence: Recurrence | null;
  publicMessage: string | null;
  privateNotes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `maintenance_windows` row as returned by D1. */
interface MaintenanceRow {
  id: string;
  title: string | null;
  scope: string;
  monitor_ids: string | null;
  starts_at: number;
  ends_at: number;
  recurrence: string | null;
  public_message: string | null;
  private_notes: string | null;
  created_at: number;
  updated_at: number;
}

/** Parse a JSON column, falling back to a sensible empty on null/corrupt data. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Map a raw row to a typed record, parsing JSON columns. */
function rowToMaintenance(row: MaintenanceRow): MaintenanceWindow {
  return {
    id: row.id,
    title: row.title,
    scope: row.scope === "global" ? "global" : "monitors",
    monitorIds: parseJson<string[] | null>(row.monitor_ids, null),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    recurrence: parseJson<Recurrence | null>(row.recurrence, null),
    publicMessage: row.public_message,
    privateNotes: row.private_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MINUTES_PER_WEEK = 7 * 24 * 60;

/**
 * Whether a maintenance window is active at instant `now` (epoch ms).
 *
 * One-time (recurrence === null): `startsAt <= now < endsAt`.
 *
 * Weekly recurrence: evaluated entirely in UTC. We map both `now` and the rule's
 * start to a "minute of the week" (0..10079, Sunday 00:00 = 0) and test whether
 * `now` falls within [start, start + durationMinutes). The membership test wraps
 * modulo the week length, so windows that cross midnight — or even the
 * Saturday→Sunday week boundary — are handled correctly.
 */
export function isWindowActiveAt(w: MaintenanceWindow, now: number): boolean {
  const r = w.recurrence;
  if (r == null) {
    return w.startsAt <= now && now < w.endsAt;
  }

  if (r.type !== "weekly") return false;
  if (r.durationMinutes <= 0) return false;

  const d = new Date(now);
  const nowMinuteOfWeek =
    d.getUTCDay() * 1440 +
    d.getUTCHours() * 60 +
    d.getUTCMinutes() +
    d.getUTCSeconds() / 60 +
    d.getUTCMilliseconds() / 60000;

  const [hStr, mStr] = r.start.split(":");
  const startHour = Number(hStr);
  const startMinute = Number(mStr);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute)) return false;

  const startMinuteOfWeek = r.weekday * 1440 + startHour * 60 + startMinute;

  // Offset from window start, normalized to [0, MINUTES_PER_WEEK).
  const offset =
    (((nowMinuteOfWeek - startMinuteOfWeek) % MINUTES_PER_WEEK) +
      MINUTES_PER_WEEK) %
    MINUTES_PER_WEEK;

  return offset < r.durationMinutes;
}

export async function listMaintenanceWindows(
  env: Env,
): Promise<MaintenanceWindow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM maintenance_windows ORDER BY starts_at",
  ).all<MaintenanceRow>();
  return (res.results ?? []).map(rowToMaintenance);
}

export async function getMaintenanceWindow(
  env: Env,
  id: string,
): Promise<MaintenanceWindow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM maintenance_windows WHERE id = ?",
  )
    .bind(id)
    .first<MaintenanceRow>();
  return row ? rowToMaintenance(row) : null;
}

export async function createMaintenanceWindow(
  env: Env,
  input: {
    title?: string | null;
    scope: "global" | "monitors";
    monitorIds?: string[] | null;
    startsAt: number;
    endsAt: number;
    recurrence?: Recurrence | null;
    publicMessage?: string | null;
    privateNotes?: string | null;
  },
): Promise<MaintenanceWindow> {
  const id = newId("mw");
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO maintenance_windows (
       id, title, scope, monitor_ids, starts_at, ends_at, recurrence,
       public_message, private_notes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.title ?? null,
      input.scope,
      input.monitorIds == null ? null : JSON.stringify(input.monitorIds),
      input.startsAt,
      input.endsAt,
      input.recurrence == null ? null : JSON.stringify(input.recurrence),
      input.publicMessage ?? null,
      input.privateNotes ?? null,
      now,
      now,
    )
    .run();

  const created = await getMaintenanceWindow(env, id);
  if (!created) {
    throw new Error("createMaintenanceWindow: failed to read back inserted row");
  }
  return created;
}

export async function updateMaintenanceWindow(
  env: Env,
  id: string,
  input: {
    title?: string | null;
    scope?: "global" | "monitors";
    monitorIds?: string[] | null;
    startsAt?: number;
    endsAt?: number;
    recurrence?: Recurrence | null;
    publicMessage?: string | null;
    privateNotes?: string | null;
  },
): Promise<MaintenanceWindow | null> {
  const existing = await getMaintenanceWindow(env, id);
  if (!existing) return null;

  // Partial update: only provided fields are written; updated_at always bumps.
  // id and created_at are preserved.
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    values.push(input.title);
  }
  if (input.scope !== undefined) {
    sets.push("scope = ?");
    values.push(input.scope);
  }
  if (input.monitorIds !== undefined) {
    sets.push("monitor_ids = ?");
    values.push(input.monitorIds == null ? null : JSON.stringify(input.monitorIds));
  }
  if (input.startsAt !== undefined) {
    sets.push("starts_at = ?");
    values.push(input.startsAt);
  }
  if (input.endsAt !== undefined) {
    sets.push("ends_at = ?");
    values.push(input.endsAt);
  }
  if (input.recurrence !== undefined) {
    sets.push("recurrence = ?");
    values.push(input.recurrence == null ? null : JSON.stringify(input.recurrence));
  }
  if (input.publicMessage !== undefined) {
    sets.push("public_message = ?");
    values.push(input.publicMessage);
  }
  if (input.privateNotes !== undefined) {
    sets.push("private_notes = ?");
    values.push(input.privateNotes);
  }
  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  await env.DB.prepare(
    `UPDATE maintenance_windows SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  return getMaintenanceWindow(env, id);
}

export async function deleteMaintenanceWindow(
  env: Env,
  id: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM maintenance_windows WHERE id = ?")
    .bind(id)
    .run();
}

/** All windows that are active at `now`. */
export async function activeWindowsAt(
  env: Env,
  now: number,
): Promise<MaintenanceWindow[]> {
  const all = await listMaintenanceWindows(env);
  return all.filter((w) => isWindowActiveAt(w, now));
}

/**
 * Whether a given monitor is currently under maintenance: true if any active
 * window is global, or scoped to monitors and includes `monitorId`.
 */
export async function isMonitorInMaintenance(
  env: Env,
  monitorId: string,
  now: number,
): Promise<boolean> {
  const active = await activeWindowsAt(env, now);
  return active.some(
    (w) =>
      w.scope === "global" ||
      (w.scope === "monitors" && (w.monitorIds?.includes(monitorId) ?? false)),
  );
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Public-facing maintenance for the status page: only windows with a non-null
 * `publicMessage`. `active` is what's running now; `upcoming` is one-time windows
 * whose `startsAt` is in the future and within the next 14 days (max 10,
 * soonest first).
 */
export async function publicMaintenance(
  env: Env,
  now: number,
): Promise<{ active: MaintenanceWindow[]; upcoming: MaintenanceWindow[] }> {
  const all = await listMaintenanceWindows(env);
  const pub = all.filter((w) => w.publicMessage != null);

  const active = pub.filter((w) => isWindowActiveAt(w, now));

  const horizon = now + FOURTEEN_DAYS_MS;
  const upcoming = pub
    .filter(
      (w) =>
        w.recurrence == null && w.startsAt > now && w.startsAt <= horizon,
    )
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, 10);

  return { active, upcoming };
}
