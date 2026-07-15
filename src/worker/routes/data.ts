import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { createMonitorSchema } from "../../shared/schemas";
import type { CreateMonitorInput } from "../../shared/schemas";
import {
  createMonitor,
  listMonitors,
  type MonitorRecord,
} from "../db/monitors";
import {
  createMaintenanceWindow,
  listMaintenanceWindows,
} from "../db/maintenance";
import { getExportableSettings } from "../db/settings";

/**
 * Data import/export API mounted at /api/data (PRD §23).
 *
 * Export produces a single JSON backup that NEVER contains secrets: monitor
 * configs are passed through `redactMonitorForExport` (auth credentials, request
 * bodies, header values and heartbeat secrets stripped, ingestion token dropped),
 * settings are filtered to non-secret keys, and incidents expose only the
 * public-safe columns (no internal error text or private notes).
 *
 * Import is validation-first and preview-able: `validateImport` checks the
 * envelope and every monitor against `createMonitorSchema` without throwing, a
 * `dryRun` reports what *would* happen (including name collisions), and the real
 * import defaults to skipping monitors whose name already exists so a restore
 * can't silently overwrite live config. Secrets are never imported (they aren't
 * present in backups) and settings are intentionally not imported in v1.
 *
 * The redaction + validation helpers are kept PURE so they're unit-testable and
 * reused without a live D1 binding. All routes require an authenticated session;
 * the auth middleware also enforces CSRF on mutations.
 */
export const data = new Hono<AppEnv>();

data.use("*", requireAuth);

// ---------------------------------------------------------------------------
// Pure export redaction.
// ---------------------------------------------------------------------------

/** A monitor as it appears in a backup: secrets stripped, no ingestion token. */
export type ExportedMonitor = Omit<MonitorRecord, "heartbeatToken" | "config"> & {
  config: Record<string, unknown>;
};

/**
 * Redact an HTTP `auth` block: keep the auth type (and basic username, which is
 * an identifier not a secret) but blank the password / drop the bearer token.
 */
function redactAuth(auth: unknown): Record<string, unknown> {
  if (auth == null || typeof auth !== "object") return { type: "none" };
  const a = auth as Record<string, unknown>;
  if (a.type === "basic") {
    return { type: "basic", username: a.username ?? "", password: "" };
  }
  if (a.type === "bearer") {
    return { type: "bearer", token: "" };
  }
  return { type: a.type ?? "none" };
}

/** Blank every header value while preserving header names (names aren't secret). */
function blankHeaders(headers: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(headers)) return [];
  return headers.map((h) => {
    const obj = (h ?? {}) as Record<string, unknown>;
    return { name: typeof obj.name === "string" ? obj.name : "", value: "" };
  });
}

/**
 * Strip secrets from a monitor's config. HTTP: drop the request body, blank
 * header values, redact auth credentials (all other fields — url, method,
 * timeouts, thresholds, expectedStatus — are kept). Heartbeat: drop the secret.
 * Defensive against malformed/partial config blobs.
 */
function redactConfig(monitor: MonitorRecord): Record<string, unknown> {
  const source = (monitor.config ?? {}) as Record<string, unknown>;

  if (monitor.type === "heartbeat") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      if (k === "secret") continue;
      out[k] = v;
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === "body" || k === "headers" || k === "auth") continue;
    out[k] = v;
  }
  out.headers = blankHeaders(source.headers);
  out.auth = redactAuth(source.auth);
  return out;
}

/**
 * PURE. Map a stored monitor to its export shape: strip secrets from config and
 * drop `heartbeatToken` entirely. Keeps url/method/schedule/assertions/public/
 * name/type/intervalSeconds (and the remaining non-secret config + metadata).
 */
export function redactMonitorForExport(monitor: MonitorRecord): ExportedMonitor {
  return {
    id: monitor.id,
    type: monitor.type,
    name: monitor.name,
    enabled: monitor.enabled,
    paused: monitor.paused,
    intervalSeconds: monitor.intervalSeconds,
    graceSeconds: monitor.graceSeconds,
    config: redactConfig(monitor),
    schedule: monitor.schedule,
    assertions: monitor.assertions,
    notify: monitor.notify,
    public: monitor.public,
    categoryId: monitor.categoryId,
    sortOrder: monitor.sortOrder,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
  };
}

/**
 * Defensive settings filter: drop any key starting with "vapid" or containing
 * "secret"/"key" (case-insensitive). `getExportableSettings` already excludes
 * encrypted values; this is belt-and-suspenders for non-secret-but-sensitive
 * keys that may have been stored in plaintext.
 */
function redactSettingsForExport(
  settings: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("vapid")) continue;
    if (lower.includes("secret")) continue;
    if (lower.includes("key")) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure import validation.
// ---------------------------------------------------------------------------

export interface ImportValidation {
  ok: boolean;
  errors: string[];
  counts: { monitors: number; maintenance: number; incidents: number };
}

/**
 * Resolve monitor ids from a backup to ids in the receiving installation.
 * Unknown ids are dropped so restored maintenance windows cannot point at
 * monitors that do not exist in this database.
 */
export function remapImportedMonitorIds(
  monitorIds: string[] | null | undefined,
  monitorIdMap: ReadonlyMap<string, string>,
): string[] | null {
  if (monitorIds == null) return null;
  return monitorIds.flatMap((id) => {
    const mapped = monitorIdMap.get(id);
    return mapped == null ? [] : [mapped];
  });
}

/**
 * PURE. Validate a backup envelope without throwing. Checks the version, that
 * the monitors/maintenance/incidents arrays are present, and that every monitor
 * parses against `createMonitorSchema` (errors are collected, never thrown).
 * `counts.monitors` is the number of VALID monitors; maintenance/incidents are
 * the array lengths.
 */
export function validateImport(raw: unknown): ImportValidation {
  const errors: string[] = [];
  const counts = { monitors: 0, maintenance: 0, incidents: 0 };

  if (raw == null || typeof raw !== "object") {
    errors.push("Backup must be a JSON object.");
    return { ok: false, errors, counts };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    errors.push(
      `Unsupported backup version: ${String(obj.version)} (expected 1).`,
    );
  }

  const monitors = obj.monitors;
  if (!Array.isArray(monitors)) {
    errors.push('Missing or invalid "monitors" array.');
  } else {
    monitors.forEach((m, i) => {
      const parsed = createMonitorSchema.safeParse(m);
      if (parsed.success) {
        counts.monitors++;
      } else {
        const detail = parsed.error.issues
          .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
          .join("; ");
        errors.push(`Monitor at index ${i} failed validation: ${detail}`);
      }
    });
  }

  const maintenance = obj.maintenance;
  if (!Array.isArray(maintenance)) {
    errors.push('Missing or invalid "maintenance" array.');
  } else {
    counts.maintenance = maintenance.length;
  }

  const incidents = obj.incidents;
  if (!Array.isArray(incidents)) {
    errors.push('Missing or invalid "incidents" array.');
  } else {
    counts.incidents = incidents.length;
  }

  return { ok: errors.length === 0, errors, counts };
}

/** Minimal validation for maintenance windows on import (best-effort restore). */
const maintenanceImportSchema = z.object({
  title: z.string().nullable().optional(),
  scope: z.enum(["global", "monitors"]),
  monitorIds: z.array(z.string()).nullable().optional(),
  startsAt: z.number(),
  endsAt: z.number(),
  recurrence: z
    .object({
      type: z.literal("weekly"),
      weekday: z.number(),
      start: z.string(),
      durationMinutes: z.number(),
    })
    .nullable()
    .optional(),
  publicMessage: z.string().nullable().optional(),
  privateNotes: z.string().nullable().optional(),
});

/**
 * Minimal validation for the public-safe incident rows produced by `/export`
 * (no internal error text / private notes are present in a backup). Restored
 * incidents are inserted as non-public (public = 0) so a restore never silently
 * re-publishes history; the operator can re-mark them public afterwards.
 */
const incidentImportSchema = z.object({
  id: z.string(),
  monitorId: z.string(),
  status: z.enum(["open", "resolved"]),
  title: z.string().nullable().optional(),
  startedAt: z.number(),
  resolvedAt: z.number().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  rootCause: z.string().nullable().optional(),
  publicMessage: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

interface ExportedIncident {
  id: string;
  monitorId: string;
  status: string;
  title: string | null;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  rootCause: string | null;
  publicMessage: string | null;
}

// GET /export — full, secret-free JSON backup as a downloadable attachment.
data.get("/export", async (c) => {
  const [monitorsList, maintenanceList, settings] = await Promise.all([
    listMonitors(c.env),
    listMaintenanceWindows(c.env),
    getExportableSettings(c.env),
  ]);

  const incidentsRes = await c.env.DB.prepare(
    `SELECT id,
            monitor_id      AS monitorId,
            status,
            title,
            started_at      AS startedAt,
            resolved_at     AS resolvedAt,
            duration_seconds AS durationSeconds,
            root_cause      AS rootCause,
            public_message  AS publicMessage
     FROM incidents
     ORDER BY started_at DESC`,
  ).all<ExportedIncident>();

  const backup = {
    version: 1,
    exportedAt: Date.now(),
    monitors: monitorsList.map(redactMonitorForExport),
    maintenance: maintenanceList,
    incidents: incidentsRes.results ?? [],
    settings: redactSettingsForExport(settings),
  };

  c.header("Content-Type", "application/json; charset=utf-8");
  c.header(
    "Content-Disposition",
    'attachment; filename="openping-backup.json"',
  );
  return c.body(JSON.stringify(backup));
});

interface ImportRequest {
  data?: unknown;
  options?: { dryRun?: boolean; skipExisting?: boolean };
}

// POST /import — validate, optionally preview (dryRun), else selectively import.
data.post("/import", async (c) => {
  const body = (await c.req.json().catch(() => undefined)) as
    | ImportRequest
    | undefined;
  const raw = body?.data;
  const options = body?.options ?? {};

  const result = validateImport(raw);
  if (!result.ok) {
    return c.json({ error: "invalid_import", errors: result.errors }, 400);
  }

  // Safe after validateImport.ok: monitors/maintenance/incidents are arrays.
  const backup = raw as {
    monitors: unknown[];
    maintenance: unknown[];
    incidents: unknown[];
  };

  // Re-parse to obtain the typed, defaulted monitor inputs we'll create, keeping
  // each backup monitor's ORIGINAL id so incidents can be remapped to the new
  // monitor ids that createMonitor() will assign.
  const validMonitors: { oldId: string | null; input: CreateMonitorInput }[] = [];
  for (const m of backup.monitors) {
    const parsed = createMonitorSchema.safeParse(m);
    if (parsed.success) {
      const rawId = (m as { id?: unknown }).id;
      validMonitors.push({
        oldId: typeof rawId === "string" ? rawId : null,
        input: parsed.data,
      });
    }
  }

  const existing = await listMonitors(c.env);
  const existingNames = new Set(existing.map((m) => m.name));
  const existingIdByName = new Map(existing.map((m) => [m.name, m.id]));

  if (options.dryRun) {
    const duplicateMonitors = validMonitors
      .map((m) => m.input.name)
      .filter((name) => existingNames.has(name));
    return c.json({
      preview: { counts: result.counts, duplicateMonitors },
    });
  }

  // Default to skipping name collisions so a restore can't silently overwrite.
  const skipExisting = options.skipExisting !== false;

  let importedMonitors = 0;
  let skippedMonitors = 0;
  const heartbeatMonitors: Array<{
    id: string;
    name: string;
    heartbeatToken: string;
  }> = [];
  // Maps each backup monitor id to the id it resolves to in THIS instance, so
  // imported incidents reference a monitor that actually exists (avoids a
  // foreign-key failure / orphaned rows on restore into a fresh instance).
  const monitorIdMap = new Map<string, string>();
  for (const { oldId, input } of validMonitors) {
    if (skipExisting && existingNames.has(input.name)) {
      skippedMonitors++;
      // Link the backup's incidents to the existing same-named monitor.
      const existingId = existingIdByName.get(input.name);
      if (oldId && existingId) monitorIdMap.set(oldId, existingId);
      continue;
    }
    const created = await createMonitor(c.env, input);
    existingNames.add(input.name);
    existingIdByName.set(input.name, created.id);
    if (oldId) monitorIdMap.set(oldId, created.id);
    if (created.type === "heartbeat" && created.heartbeatToken) {
      heartbeatMonitors.push({
        id: created.id,
        name: created.name,
        heartbeatToken: created.heartbeatToken,
      });
    }
    importedMonitors++;
  }

  let importedMaintenance = 0;
  let skippedMaintenance = 0;
  for (const w of backup.maintenance) {
    const parsed = maintenanceImportSchema.safeParse(w);
    if (!parsed.success) {
      skippedMaintenance++;
      continue;
    }
    const monitorIds = remapImportedMonitorIds(
      parsed.data.monitorIds,
      monitorIdMap,
    );
    if (
      parsed.data.scope === "monitors" &&
      (!monitorIds || monitorIds.length === 0)
    ) {
      skippedMaintenance++;
      continue;
    }
    await createMaintenanceWindow(c.env, {
      title: parsed.data.title ?? null,
      scope: parsed.data.scope,
      monitorIds: parsed.data.scope === "global" ? null : monitorIds,
      startsAt: parsed.data.startsAt,
      endsAt: parsed.data.endsAt,
      recurrence: parsed.data.recurrence ?? null,
      publicMessage: parsed.data.publicMessage ?? null,
      privateNotes: parsed.data.privateNotes ?? null,
    });
    importedMaintenance++;
  }

  // Incidents: insert the public-safe rows from the backup, remapping each to its
  // monitor's id in this instance. Incidents whose monitor wasn't imported are
  // skipped (no dangling foreign key). `INSERT OR IGNORE` keeps re-import
  // idempotent (a colliding incident id is skipped). Restored rows are non-public.
  let importedIncidents = 0;
  let skippedIncidents = 0;
  const importNow = Date.now();
  for (const inc of backup.incidents) {
    const parsed = incidentImportSchema.safeParse(inc);
    if (!parsed.success) {
      skippedIncidents++;
      continue;
    }
    const d = parsed.data;
    const monitorId = monitorIdMap.get(d.monitorId);
    if (!monitorId) {
      skippedIncidents++; // its monitor wasn't imported into this instance
      continue;
    }
    const res = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO incidents (
         id, monitor_id, status, title, root_cause, started_at, resolved_at,
         duration_seconds, public_message, public, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(
        d.id,
        monitorId,
        d.status,
        d.title ?? null,
        d.rootCause ?? null,
        d.startedAt,
        d.resolvedAt ?? null,
        d.durationSeconds ?? null,
        d.publicMessage ?? null,
        importNow,
        importNow,
      )
      .run();
    if (res.meta?.changes) importedIncidents++;
    else skippedIncidents++; // id collision — already present
  }

  return c.json({
    imported: {
      monitors: importedMonitors,
      maintenance: importedMaintenance,
      incidents: importedIncidents,
    },
    skipped: {
      monitors: skippedMonitors,
      maintenance: skippedMaintenance,
      incidents: skippedIncidents,
    },
    // These bearer credentials are generated during restore and cannot be read
    // from D1 later. Return them once, just like the monitor creation endpoint.
    heartbeatMonitors,
  });
});
