import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getMonitorByHeartbeatToken } from "../db/monitors";
import { recordHeartbeat } from "../checks/state";
import { isMonitorInMaintenance } from "../db/maintenance";
import { isActiveAt } from "../lib/schedule";
import { timingSafeEqual } from "../lib/timing";
import type { HeartbeatConfig } from "../../shared/schemas";

/**
 * Public heartbeat ingestion endpoint (PRD §6.3). External cron jobs / scripts
 * POST (or GET) to /hb/:token to report that they ran. This router is mounted
 * UNAUTHENTICATED — it is intentionally not behind requireAuth; access control
 * is the unguessable token plus an optional per-monitor secret.
 */
export const heartbeats = new Hono<AppEnv>();

// With no explicit per-monitor allowlist we accept POST and HEAD only. GET is
// the method link-preview/prefetch bots and browser address-bar probes use, so
// allowing it by default lets them fire false success beats. NOTE: this is an
// intentional behavior change — heartbeats that previously relied on a bare GET
// must now configure `acceptedMethods` (e.g. ["GET"]) or switch to POST.
const DEFAULT_ACCEPTED_METHODS = ["POST", "HEAD"];

// Minimum spacing between beats we actually persist for a given token. Heartbeat
// monitors have a schema-enforced minimum interval of 60s, so this floor never
// throttles a legitimate beat (or a quick client retry) — it only caps abusive
// tight-loop spam on a leaked token from exhausting the D1 write budget. A
// throttled beat returns 200 (the monitor's liveness was already just recorded);
// only the redundant follow-on writes are skipped.
const MIN_INGEST_INTERVAL_MS = 5000;

/** True iff `method` is accepted (defaulting to POST/HEAD when none configured). */
export function isMethodAllowed(
  accepted: string[] | undefined,
  method: string,
): boolean {
  const allow = accepted && accepted.length > 0 ? accepted : DEFAULT_ACCEPTED_METHODS;
  const m = method.toUpperCase();
  return allow.some((a) => a.toUpperCase() === m);
}

/**
 * True when no secret is configured, otherwise the provided value must match.
 * Uses a constant-time comparison to avoid leaking the secret via timing.
 */
export async function checkSecret(
  configured: string | undefined,
  provided: string | undefined,
): Promise<boolean> {
  if (!configured) return true;
  return provided != null && (await timingSafeEqual(provided, configured));
}

export interface HeartbeatPayload {
  durationMs?: number;
  exitStatus?: number;
  message?: string;
  runId?: string;
  metrics?: Record<string, number>;
}

/** Coerce a query/body value to a finite number; return undefined for NaN/empty. */
function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a value to a non-empty string (numbers are stringified). */
function toText(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  return undefined;
}

// The /hb/:token endpoint is the one genuinely public WRITE path, and its
// payload is persisted verbatim into samples.meta. Cap every attacker-controllable
// field so a known token can't be used to bloat storage / exhaust the D1 write
// budget with oversized beats.
const MAX_MESSAGE_CHARS = 1000;
const MAX_RUNID_CHARS = 200;
const MAX_METRICS_KEYS = 50;
const MAX_METRIC_NAME_CHARS = 100;

/**
 * Keep only numeric (finite) values from an arbitrary metrics object, bounded to
 * MAX_METRICS_KEYS to cap the persisted size.
 */
function filterMetrics(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (
      k.length > 0 &&
      k.length <= MAX_METRIC_NAME_CHARS &&
      typeof val === "number" &&
      Number.isFinite(val)
    ) {
      out[k] = val;
      if (Object.keys(out).length >= MAX_METRICS_KEYS) break;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Lenient parse of heartbeat metadata from query params and an optional JSON
 * body. The body takes precedence over query params when it supplies a value.
 * Only defined fields are returned.
 */
export function parseHeartbeatPayload(
  query: Record<string, string>,
  body: unknown,
): HeartbeatPayload {
  const b: Record<string, unknown> =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const durationMs = toNumber(
    b.durationMs ?? b.duration ?? query.duration ?? query.ms ?? query.durationMs,
  );
  const exitStatus = toNumber(
    b.exitStatus ?? b.status ?? query.status ?? query.exit ?? query.exitStatus,
  );
  const message = toText(b.message ?? query.msg ?? query.message)?.slice(
    0,
    MAX_MESSAGE_CHARS,
  );
  const runId = toText(
    b.runId ?? b.run_id ?? query.rid ?? query.run_id ?? query.runId,
  )?.slice(0, MAX_RUNID_CHARS);
  const metrics = filterMetrics(b.metrics);

  const payload: HeartbeatPayload = {};
  if (durationMs !== undefined) payload.durationMs = durationMs;
  if (exitStatus !== undefined) payload.exitStatus = exitStatus;
  if (message !== undefined) payload.message = message;
  if (runId !== undefined) payload.runId = runId;
  if (metrics !== undefined) payload.metrics = metrics;
  return payload;
}

/** Extract the token from an `Authorization: Bearer <secret>` header. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

heartbeats.all("/:token", async (c) => {
  const token = c.req.param("token");
  const monitor = await getMonitorByHeartbeatToken(c.env, token);
  if (!monitor) return c.json({ error: "not_found" }, 404);

  const cfg = monitor.config as HeartbeatConfig;

  if (!isMethodAllowed(cfg.acceptedMethods, c.req.method)) {
    return c.json({ error: "method_not_allowed" }, 405);
  }

  const provided =
    c.req.query("secret") ??
    c.req.header("x-heartbeat-secret") ??
    bearerToken(c.req.header("authorization"));
  if (!(await checkSecret(cfg.secret, provided))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const now = Date.now();
  // Rate-limit: drop (but ack) beats that arrive within MIN_INGEST_INTERVAL_MS of
  // the last recorded one, so a leaked token can't spam writes. A cheap indexed
  // read; fails open if it errors so a real beat is never lost.
  const last = await c.env.DB.prepare(
    "SELECT last_beat_at FROM monitor_state WHERE monitor_id = ?",
  )
    .bind(monitor.id)
    .first<{ last_beat_at: number | null }>()
    .catch(() => null);
  if (last?.last_beat_at != null && now - last.last_beat_at < MIN_INGEST_INTERVAL_MS) {
    return c.json({ ok: true, monitor: monitor.id, throttled: true });
  }

  const contentType = c.req.header("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await c.req.json().catch(() => undefined)
    : undefined;

  const payload = parseHeartbeatPayload(c.req.query(), body);
  // Suppress incidents/alerts and uptime accrual for beats that land during a
  // maintenance window OR outside the monitor's schedule window — the scheduler
  // already does this for HTTP checks (PRD §16/§7). The beat is still recorded
  // so deadline tracking stays sane; it just must not count against uptime or
  // page anyone for an off-hours run.
  const maintenance = await isMonitorInMaintenance(c.env, monitor.id, now);
  const scheduledOff = !isActiveAt(monitor.schedule, new Date(now));
  await recordHeartbeat(
    c.env,
    monitor,
    { at: now, ...payload },
    { maintenance, scheduledOff },
  );

  return c.json({ ok: true, monitor: monitor.id });
});
