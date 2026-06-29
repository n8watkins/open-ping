import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getMonitorByHeartbeatToken } from "../db/monitors";
import { recordHeartbeat } from "../checks/state";
import type { HeartbeatConfig } from "../../shared/schemas";

/**
 * Public heartbeat ingestion endpoint (PRD §6.3). External cron jobs / scripts
 * POST (or GET) to /hb/:token to report that they ran. This router is mounted
 * UNAUTHENTICATED — it is intentionally not behind requireAuth; access control
 * is the unguessable token plus an optional per-monitor secret.
 */
export const heartbeats = new Hono<AppEnv>();

/** True if no method allowlist is set, else true iff `method` is in `accepted`. */
export function isMethodAllowed(
  accepted: string[] | undefined,
  method: string,
): boolean {
  if (!accepted || accepted.length === 0) return true;
  const m = method.toUpperCase();
  return accepted.some((a) => a.toUpperCase() === m);
}

/**
 * True when no secret is configured, otherwise the provided value must match.
 * NOTE: a constant-time comparison is a future hardening item; a plain `===`
 * is acceptable for now.
 */
export function checkSecret(
  configured: string | undefined,
  provided: string | undefined,
): boolean {
  if (!configured) return true;
  return provided === configured;
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
  return Number.isNaN(n) ? undefined : n;
}

/** Coerce a value to a non-empty string (numbers are stringified). */
function toText(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  return undefined;
}

/** Keep only numeric (finite) values from an arbitrary metrics object. */
function filterMetrics(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && !Number.isNaN(val)) out[k] = val;
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
  const message = toText(b.message ?? query.msg ?? query.message);
  const runId = toText(
    b.runId ?? b.run_id ?? query.rid ?? query.run_id ?? query.runId,
  );
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
  if (!checkSecret(cfg.secret, provided)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const contentType = c.req.header("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await c.req.json().catch(() => undefined)
    : undefined;

  const payload = parseHeartbeatPayload(c.req.query(), body);
  await recordHeartbeat(c.env, monitor, { at: Date.now(), ...payload });

  return c.json({ ok: true, monitor: monitor.id });
});
