import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { createMonitorSchema } from "../../shared/schemas";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  listMonitors,
  rotateHeartbeatToken,
  setPaused,
  updateMonitor,
} from "../db/monitors";
import { runMonitorCheck } from "../checks/runner";
import { applyCheckResult, readState } from "../checks/state";
import { parseDomainCache } from "../checks/domain";
import { firstCheckWithin, type FirstCheckResult } from "../checks/first-check";
import {
  computeUptime,
  computeIncidentMetrics,
  computeUptimeWindows,
  UPTIME_WINDOWS,
} from "../history/metrics";
import { redactConfig } from "../lib/secret-config";
import type { MonitorRecord } from "../db/monitors";

/** Strip secret config fields and ingestion credentials from normal responses. */
export function redactMonitor(m: MonitorRecord): MonitorRecord {
  return {
    ...m,
    heartbeatToken: null,
    config: redactConfig(
      m.config as Record<string, unknown>,
    ) as MonitorRecord["config"],
  };
}

/** Include a new heartbeat token only in the monitor creation response. */
export function presentCreatedMonitor(m: MonitorRecord): MonitorRecord {
  const redacted = redactMonitor(m);
  return m.type === "heartbeat"
    ? { ...redacted, heartbeatToken: m.heartbeatToken }
    : redacted;
}


/**
 * A partial monitor update: only the fields present change. `config` and
 * `public` are merged key by key into the stored values (a config key set to
 * null is removed); every other field replaces the stored value. The merged
 * result is then validated with the same `createMonitorSchema` as a full PUT.
 * `type` may be sent but must match the stored type.
 */
export const monitorPatchSchema = z
  .object({
    type: z.string().optional(),
    name: z.unknown().optional(),
    enabled: z.unknown().optional(),
    confirmFailures: z.unknown().optional(),
    schedule: z.unknown().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    assertions: z.unknown().optional(),
    notify: z.unknown().optional(),
    public: z.record(z.string(), z.unknown()).optional(),
    categoryId: z.unknown().optional(),
  })
  .strict();
export type MonitorPatch = z.infer<typeof monitorPatchSchema>;

/**
 * PURE. Apply a {@link MonitorPatch} to a stored (decrypted, unredacted)
 * monitor, giving a full create/update body. Secrets never leave the server on
 * this path: the merge starts from the stored config, so a patch that does not
 * mention a credential keeps it.
 */
export function mergeMonitorPatch(
  existing: MonitorRecord,
  patch: MonitorPatch,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...(existing.config as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    if (value === null) delete config[key];
    else config[key] = value;
  }
  const pick = <T>(value: T | undefined, fallback: unknown) =>
    value !== undefined ? value : fallback;
  return {
    type: existing.type,
    name: pick(patch.name, existing.name),
    enabled: pick(patch.enabled, existing.enabled),
    confirmFailures: pick(patch.confirmFailures, existing.confirmFailures),
    schedule: pick(patch.schedule, existing.schedule),
    notify: pick(patch.notify, existing.notify),
    public: patch.public ? { ...existing.public, ...patch.public } : existing.public,
    categoryId: pick(patch.categoryId, existing.categoryId),
    config,
    ...(existing.type === "http"
      ? { assertions: pick(patch.assertions, existing.assertions) }
      : {}),
  };
}

/** Outcome of a monitor write, mapped to a response by each caller. */
export type MonitorWriteResult =
  | { ok: true; monitor: MonitorRecord }
  | {
      ok: false;
      status: 400 | 404;
      error: "validation" | "not_found" | "type_immutable";
      issues?: z.core.$ZodIssue[];
    };

/** Validate and create a monitor (POST /api/monitors and the MCP tool). */
export async function createMonitorFromBody(
  env: Env,
  body: unknown,
): Promise<MonitorWriteResult> {
  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "validation", issues: parsed.error.issues };
  }
  return { ok: true, monitor: await createMonitor(env, parsed.data) };
}

/**
 * Create a monitor and run its first check right away (POST /api/monitors, the
 * web editor, MCP create_monitor and the CLI). The response waits a few
 * seconds for that check; a slower one finishes through `waitUntil`.
 */
export async function createMonitorAndCheck(
  env: Env,
  body: unknown,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
): Promise<MonitorWriteResult & { firstCheck?: FirstCheckResult }> {
  const r = await createMonitorFromBody(env, body);
  if (!r.ok) return r;
  return { ...r, firstCheck: await firstCheckWithin(env, r.monitor, waitUntil) };
}

/** The request's `waitUntil`, when the runtime gave it one. */
export function requestWaitUntil(c: {
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    // Hono throws when there is no execution context (some test harnesses).
    return undefined;
  }
}

/** Validate and fully replace a monitor (PUT /api/monitors/:id). */
export async function replaceMonitor(
  env: Env,
  id: string,
  body: unknown,
): Promise<MonitorWriteResult> {
  const parsed = createMonitorSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "validation", issues: parsed.error.issues };
  }
  const existing = await getMonitor(env, id);
  if (!existing) return { ok: false, status: 404, error: "not_found" };
  if (existing.type !== parsed.data.type) {
    return { ok: false, status: 400, error: "type_immutable" };
  }
  const monitor = await updateMonitor(env, id, parsed.data);
  if (!monitor) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, monitor };
}

/** Validate and partially update a monitor (PATCH /api/monitors/:id and MCP). */
export async function patchMonitor(
  env: Env,
  id: string,
  body: unknown,
): Promise<MonitorWriteResult> {
  const patch = monitorPatchSchema.safeParse(body);
  if (!patch.success) {
    return { ok: false, status: 400, error: "validation", issues: patch.error.issues };
  }
  const existing = await getMonitor(env, id);
  if (!existing) return { ok: false, status: 404, error: "not_found" };
  if (patch.data.type !== undefined && patch.data.type !== existing.type) {
    return { ok: false, status: 400, error: "type_immutable" };
  }
  const parsed = createMonitorSchema.safeParse(mergeMonitorPatch(existing, patch.data));
  if (!parsed.success) {
    return { ok: false, status: 400, error: "validation", issues: parsed.error.issues };
  }
  const monitor = await updateMonitor(env, id, parsed.data);
  if (!monitor) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, monitor };
}

/** Uptime of every monitor over 24h, 7d, 30d and 90d (three D1 reads). */
export async function listMonitorUptime(env: Env, now: number = Date.now()) {
  const [list, windows] = await Promise.all([
    listMonitors(env),
    computeUptimeWindows(env, now),
  ]);
  return {
    windows: UPTIME_WINDOWS.map((w) => ({ key: w.key, label: w.label })),
    monitors: list.map((m) => {
      const uptime = windows.get(m.id);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        paused: m.paused,
        ...Object.fromEntries(
          UPTIME_WINDOWS.map((w) => {
            const r = uptime?.[w.key];
            return [
              w.key,
              {
                uptimePct: r?.uptimePct ?? 100,
                checks: r?.checks ?? 0,
                downSeconds: r?.downSeconds ?? 0,
              },
            ];
          }),
        ),
      } as {
        id: string;
        name: string;
        type: MonitorRecord["type"];
        paused: boolean;
      } & Record<
        (typeof UPTIME_WINDOWS)[number]["key"],
        { uptimePct: number; checks: number; downSeconds: number }
      >;
    }),
  };
}

/** Map a failed write to the JSON error body the REST API has always used. */
function writeError(r: Extract<MonitorWriteResult, { ok: false }>) {
  return r.issues ? { error: r.error, issues: r.issues } : { error: r.error };
}

/**
 * Monitor CRUD API mounted at /api/monitors. All routes require an
 * authenticated session; the auth middleware also enforces CSRF on mutations.
 *
 * Secret config fields (auth password/token, heartbeat secret) are blanked in
 * every response via `redactMonitor`; the editor resubmits the blanked value and
 * `db/monitors.updateMonitor` merges the stored secret back in (`mergeSecrets`).
 */
export const monitors = new Hono<AppEnv>();

monitors.use("*", requireAuth);

monitors.get("/", async (c) => {
  const list = await listMonitors(c.env);
  return c.json({ monitors: list.map(redactMonitor) });
});

monitors.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const r = await createMonitorAndCheck(c.env, body, requestWaitUntil(c));
  if (!r.ok) return c.json(writeError(r), r.status);
  return c.json({ monitor: presentCreatedMonitor(r.monitor), firstCheck: r.firstCheck }, 201);
});

// Registered before /:id so the static path wins.
monitors.get("/uptime", async (c) => c.json(await listMonitorUptime(c.env)));

monitors.get("/:id", async (c) => {
  const monitor = await getMonitor(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

/** Rich detail: monitor + current state + uptime windows + latency + incidents. */
monitors.get("/:id/detail", async (c) => {
  const id = c.req.param("id");
  const monitor = await getMonitor(c.env, id);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const DAY = 86400000;

  const state = await c.env.DB.prepare(
    `SELECT state, state_since, last_checked_at, last_success_at, last_duration_ms,
            last_status_code, last_error, consecutive_failures, consecutive_successes,
            next_check_at, active_incident_id, is_flapping
     FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(id)
    .first();

  const [d1, d7, d30, d365] = await Promise.all([
    computeUptime(c.env, id, now - DAY, now),
    computeUptime(c.env, id, now - 7 * DAY, now),
    computeUptime(c.env, id, now - 30 * DAY, now),
    computeUptime(c.env, id, now - 365 * DAY, now),
  ]);

  const latency = await c.env.DB.prepare(
    `SELECT AVG(duration_ms) AS avg, MIN(duration_ms) AS min, MAX(duration_ms) AS max
     FROM samples WHERE monitor_id = ? AND ok = 1 AND duration_ms IS NOT NULL AND at >= ?`,
  )
    .bind(id, now - DAY)
    .first<{ avg: number | null; min: number | null; max: number | null }>();

  const samplesRes = await c.env.DB.prepare(
    `SELECT at, ok, state, duration_ms AS durationMs, status_code AS statusCode, error, meta
     FROM samples WHERE monitor_id = ? AND at >= ? ORDER BY at`,
  )
    .bind(id, now - DAY)
    .all<Record<string, unknown> & { meta: string | null }>();
  // Only the latest sample carries its type-specific meta (resolved DNS records,
  // domain expiry), which the page shows next to the target.
  const samples = (samplesRes.results ?? []).map(({ meta, ...sample }, i, all) => {
    if (i !== all.length - 1 || !meta) return sample;
    try {
      return { ...sample, meta: JSON.parse(meta) as unknown };
    } catch {
      return sample;
    }
  });

  const incidentsRes = await c.env.DB.prepare(
    `SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt,
            duration_seconds AS durationSeconds, error
     FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(id)
    .all();

  const incidentMetrics = await computeIncidentMetrics(c.env, id, now);

  return c.json({
    monitor: redactMonitor(monitor),
    state,
    uptime: { d1: d1.uptimePct, d7: d7.uptimePct, d30: d30.uptimePct, d365: d365.uptimePct },
    latency: { avg: latency?.avg ?? null, min: latency?.min ?? null, max: latency?.max ?? null },
    incidentMetrics,
    recentSamples: samples,
    recentIncidents: incidentsRes.results ?? [],
  });
});

monitors.put("/:id", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const r = await replaceMonitor(c.env, c.req.param("id"), body);
  if (!r.ok) return c.json(writeError(r), r.status);
  return c.json({ monitor: redactMonitor(r.monitor) });
});

/** Partial update: see {@link monitorPatchSchema}. */
monitors.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const r = await patchMonitor(c.env, c.req.param("id"), body);
  if (!r.ok) return c.json(writeError(r), r.status);
  return c.json({ monitor: redactMonitor(r.monitor) });
});

monitors.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getMonitor(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteMonitor(c.env, id);
  return c.json({ ok: true });
});

monitors.post("/:id/pause", async (c) => {
  const monitor = await setPaused(c.env, c.req.param("id"), true);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

monitors.post("/:id/resume", async (c) => {
  const monitor = await setPaused(c.env, c.req.param("id"), false);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  return c.json({ monitor: redactMonitor(monitor) });
});

monitors.post("/:id/rotate-heartbeat-token", async (c) => {
  const token = await rotateHeartbeatToken(c.env, c.req.param("id"));
  if (!token) return c.json({ error: "not_found" }, 404);
  return c.json({ heartbeatToken: token });
});

/**
 * Manual test (PRD §9). Runs a check now and returns the outcome. By default it
 * does NOT affect stored history/state; pass ?apply=1 to persist the result.
 * Available for all polled types (http/dns/tcp/domain); heartbeats are
 * push-driven and cannot be actively probed. A domain monitor always asks RDAP,
 * falling back to its cached read if that fails, like a scheduled check. An
 * outcome whose confirmation was deferred (RDAP rate limited the lookup) is
 * returned but never applied: it is the scheduler's to retry.
 */
monitors.post("/:id/test", async (c) => {
  const monitor = await getMonitor(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "not_found" }, 404);
  if (monitor.type === "heartbeat") {
    return c.json({ error: "not_testable", message: "Heartbeat monitors are push-driven." }, 400);
  }
  const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";
  const known = monitor.type === "domain" || apply ? await readState(c.env, monitor.id) : undefined;
  const outcome = await runMonitorCheck(monitor, {
    confirm: monitor.confirmFailures !== "off",
    ...(monitor.type === "domain"
      ? { domainCache: parseDomainCache(known?.domain_cache), refreshDomain: true }
      : {}),
    now: Date.now(),
  });
  const applied = apply && outcome.confirmation !== "deferred";
  if (applied) await applyCheckResult(c.env, monitor, outcome, known);
  return c.json({ outcome, applied });
});
