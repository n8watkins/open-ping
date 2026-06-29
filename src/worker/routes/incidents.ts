import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import type { IncidentRecord } from "../db/incidents";
import { requireAuth } from "../middleware/auth";
import { newId } from "../lib/ids";

/**
 * Incidents read/management API mounted at /api/incidents (PRD §16 Incidents).
 * List with filters, detail with timeline, annotate (private notes / public
 * message / visibility / root cause / resolution), and CSV + JSON export. All
 * routes require an authenticated session; the auth middleware also enforces
 * CSRF on mutations.
 *
 * Reads use inline D1 queries (db/incidents.ts owns the lifecycle writes); the
 * camelCase mapping here mirrors that module's IncidentRecord shape and adds the
 * joined `monitorName`. The shared `buildFilter` + `csvCell` helpers are kept
 * pure so list and both exports share one filtering/escaping implementation.
 */
export const incidents = new Hono<AppEnv>();

incidents.use("*", requireAuth);

/** An incident plus the joined monitor name (null if the monitor is gone). */
type IncidentWithMonitor = IncidentRecord & { monitorName: string | null };

/** Raw `incidents` row (optionally with the joined `monitor_name`). */
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
  monitor_name?: string | null;
}

/** Raw `incident_events` row. */
interface IncidentEventRow {
  id: string;
  incident_id: string;
  at: number;
  kind: string;
  message: string | null;
  data: string | null;
}

/** Map a raw incident row to a typed record, coercing 0/1 to booleans. */
function mapRow(row: IncidentRow): IncidentWithMonitor {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name ?? null,
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

/** Map a raw timeline event row to a camelCase object. */
function mapEvent(row: IncidentEventRow) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    at: row.at,
    kind: row.kind,
    message: row.message,
    data: row.data,
  };
}

/** Parse a numeric query value; null when absent or not a finite number. */
function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whitelisted sort columns (ORDER BY can't be bound — never interpolate). */
const SORT_COLUMNS: Record<string, string> = {
  started_at: "i.started_at",
  resolved_at: "i.resolved_at",
  created_at: "i.created_at",
  updated_at: "i.updated_at",
  duration_seconds: "i.duration_seconds",
};

/** Resolve a safe ORDER BY column, defaulting to `started_at`. */
function resolveSortColumn(sort: string | undefined): string {
  if (sort && Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort)) {
    return SORT_COLUMNS[sort];
  }
  return SORT_COLUMNS.started_at;
}

/** Clamp the list limit to [1, 500], defaulting to 100. */
function resolveLimit(value: string | undefined): number {
  const n = toNumber(value);
  if (n === null) return 100;
  const i = Math.floor(n);
  if (i <= 0) return 100;
  return Math.min(i, 500);
}

/**
 * Build a parameterized WHERE clause from query filters, shared by list + both
 * exports. Returns the condition body (no `WHERE` keyword; empty string when no
 * filters apply) and the positional binds. Values are only ever bound, never
 * interpolated, so this is SQL-injection-safe. Conditions reference the `i`
 * alias (incidents) used by all three callers.
 */
function buildFilter(query: Record<string, string | undefined>): {
  where: string;
  binds: unknown[];
} {
  const conds: string[] = [];
  const binds: unknown[] = [];

  const status = query.status;
  if (status === "open" || status === "resolved") {
    conds.push("i.status = ?");
    binds.push(status);
  }

  const monitorId = query.monitorId;
  if (monitorId) {
    conds.push("i.monitor_id = ?");
    binds.push(monitorId);
  }

  const rootCause = query.rootCause;
  if (rootCause) {
    conds.push("i.root_cause = ?");
    binds.push(rootCause);
  }

  const from = toNumber(query.from);
  if (from !== null) {
    conds.push("i.started_at >= ?");
    binds.push(from);
  }

  const to = toNumber(query.to);
  if (to !== null) {
    conds.push("i.started_at <= ?");
    binds.push(to);
  }

  const q = query.q;
  if (q && q.trim() !== "") {
    conds.push("i.title LIKE ?");
    binds.push(`%${q}%`);
  }

  return { where: conds.length > 0 ? conds.join(" AND ") : "", binds };
}

/** Format epoch-ms as ISO 8601, or "" for null (used in CSV export). */
function toIso(ms: number | null): string {
  return ms == null ? "" : new Date(ms).toISOString();
}

/**
 * Render a single CSV cell (RFC 4180): stringify, and when the value contains a
 * comma, double-quote, CR, or LF, wrap it in double-quotes and escape embedded
 * quotes by doubling them. Null/undefined become an empty cell.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Run the shared filtered SELECT (joined monitor name), newest first. */
async function queryIncidents(
  env: AppEnv["Bindings"],
  query: Record<string, string | undefined>,
  limit?: number,
): Promise<IncidentWithMonitor[]> {
  const { where, binds } = buildFilter(query);
  const sortCol = resolveSortColumn(query.sort);
  const whereSql = where ? ` WHERE ${where}` : "";
  const limitSql = limit !== undefined ? " LIMIT ?" : "";
  const sql =
    `SELECT i.*, m.name AS monitor_name FROM incidents i ` +
    `LEFT JOIN monitors m ON m.id = i.monitor_id${whereSql} ` +
    `ORDER BY ${sortCol} DESC${limitSql}`;
  const stmt =
    limit !== undefined
      ? env.DB.prepare(sql).bind(...binds, limit)
      : env.DB.prepare(sql).bind(...binds);
  const { results } = await stmt.all<IncidentRow>();
  return (results ?? []).map(mapRow);
}

// GET / — filtered list (status, monitorId, rootCause, from, to, q, sort, limit).
incidents.get("/", async (c) => {
  const query = c.req.query();
  const limit = resolveLimit(query.limit);
  const list = await queryIncidents(c.env, query, limit);

  const { where, binds } = buildFilter(query);
  const whereSql = where ? ` WHERE ${where}` : "";
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM incidents i${whereSql}`,
  )
    .bind(...binds)
    .first<{ c: number }>();

  return c.json({ incidents: list, total: countRow?.c ?? 0 });
});

// GET /export.json — full filtered array as a downloadable JSON attachment.
// Registered before /:id so the static path wins.
incidents.get("/export.json", async (c) => {
  const list = await queryIncidents(c.env, c.req.query());
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="incidents.json"');
  return c.body(JSON.stringify(list));
});

// GET /export.csv — full filtered array as a downloadable CSV attachment.
incidents.get("/export.csv", async (c) => {
  const list = await queryIncidents(c.env, c.req.query());
  const header = [
    "id",
    "monitor",
    "status",
    "started_at",
    "resolved_at",
    "duration_seconds",
    "http_status",
    "error",
    "root_cause",
    "title",
  ];
  const lines = [header.join(",")];
  for (const inc of list) {
    lines.push(
      [
        csvCell(inc.id),
        csvCell(inc.monitorName),
        csvCell(inc.status),
        csvCell(toIso(inc.startedAt)),
        csvCell(toIso(inc.resolvedAt)),
        csvCell(inc.durationSeconds),
        csvCell(inc.httpStatus),
        csvCell(inc.error),
        csvCell(inc.rootCause),
        csvCell(inc.title),
      ].join(","),
    );
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="incidents.csv"');
  return c.body(lines.join("\r\n"));
});

// GET /:id — incident detail plus its timeline (events ordered by `at`).
incidents.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT i.*, m.name AS monitor_name FROM incidents i " +
      "LEFT JOIN monitors m ON m.id = i.monitor_id WHERE i.id = ?",
  )
    .bind(id)
    .first<IncidentRow>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id, incident_id, at, kind, message, data FROM incident_events " +
      "WHERE incident_id = ? ORDER BY at ASC",
  )
    .bind(id)
    .all<IncidentEventRow>();

  return c.json({ incident: mapRow(row), events: (results ?? []).map(mapEvent) });
});

const patchSchema = z.object({
  privateNotes: z.string().nullable().optional(),
  publicMessage: z.string().nullable().optional(),
  public: z.boolean().optional(),
  rootCause: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
});

// PATCH /:id — annotate the incident; only provided fields are updated. When a
// non-empty publicMessage is set, append a `public_update` timeline event.
incidents.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM incidents WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const data = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (data.privateNotes !== undefined) {
    sets.push("private_notes = ?");
    binds.push(data.privateNotes);
  }
  if (data.publicMessage !== undefined) {
    sets.push("public_message = ?");
    binds.push(data.publicMessage);
  }
  if (data.public !== undefined) {
    sets.push("public = ?");
    binds.push(data.public ? 1 : 0);
  }
  if (data.rootCause !== undefined) {
    sets.push("root_cause = ?");
    binds.push(data.rootCause);
  }
  if (data.resolution !== undefined) {
    sets.push("resolution = ?");
    binds.push(data.resolution);
  }

  const now = Date.now();
  sets.push("updated_at = ?");
  binds.push(now);

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`).bind(
      ...binds,
      id,
    ),
  ];
  if (typeof data.publicMessage === "string" && data.publicMessage.length > 0) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO incident_events (id, incident_id, at, kind, message) " +
          "VALUES (?, ?, ?, 'public_update', ?)",
      ).bind(newId("iev"), id, now, data.publicMessage),
    );
  }
  await c.env.DB.batch(statements);

  const row = await c.env.DB.prepare(
    "SELECT i.*, m.name AS monitor_name FROM incidents i " +
      "LEFT JOIN monitors m ON m.id = i.monitor_id WHERE i.id = ?",
  )
    .bind(id)
    .first<IncidentRow>();
  return c.json({ incident: row ? mapRow(row) : null });
});
