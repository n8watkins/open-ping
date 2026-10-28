import { DateTime } from "luxon";
import type { MonitorRecord } from "../db/monitors";
import { redactMonitor } from "../routes/monitors";

/**
 * Output helpers for the MCP tools: ISO times in the install's timezone,
 * stricter-than-the-API monitor redaction, and the text + structured result
 * shape every tool returns. Pure, so they are unit-tested without D1.
 */

/** A tool result: compact text for the model plus the same data as JSON. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Epoch ms as an ISO 8601 string in `zone` (falls back to UTC). */
export function iso(ms: number | null | undefined, zone: string): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  // Whole seconds: sub-second precision is noise for a 12-minute check cycle.
  const whole = Math.floor(ms / 1000) * 1000;
  const dt = DateTime.fromMillis(whole, { zone });
  return (dt.isValid ? dt : DateTime.fromMillis(whole, { zone: "utc" })).toISO({
    suppressMilliseconds: true,
  });
}

/**
 * Keys holding epoch-ms timestamps in OpenPing records (createdAt, startedAt,
 * stateSince, at, ...). Durations (durationMs, intervalSeconds) never match.
 */
const TIME_KEY = /^(at|since)$|At$|Since$/;
/** Anything below this is not an epoch-ms timestamp (it is before 1973). */
const MIN_EPOCH_MS = 1e11;

/** Deep copy of `value` with every epoch-ms timestamp turned into ISO in `zone`. */
export function withIsoTimes<T>(value: T, zone: string): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, walk(inner, k)]),
      );
    }
    if (key && TIME_KEY.test(key) && typeof v === "number" && v >= MIN_EPOCH_MS) {
      return iso(v, zone);
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * A monitor safe to hand to a model. Starts from the REST API's
 * {@link redactMonitor} (auth password and token, heartbeat secret and
 * heartbeat token blanked) and also blanks every custom header value and drops
 * the request body, as backups do: they often carry API keys or session
 * cookies, and tool output leaves the install for the model provider.
 * Updates never round-trip through this view, so nothing is lost.
 */
export function redactMonitorForMcp(m: MonitorRecord): MonitorRecord {
  const redacted = redactMonitor(m);
  const config = { ...(redacted.config as Record<string, unknown>) };
  if (Array.isArray(config.headers)) {
    config.headers = (config.headers as { name?: unknown }[]).map((h) => ({
      name: typeof h?.name === "string" ? h.name : "",
      value: "",
    }));
  }
  if (typeof config.body === "string") {
    delete config.body;
    config.bodySet = true;
  }
  return { ...redacted, config: config as MonitorRecord["config"] };
}

/** Success result: `text` for the model, `data` (ISO-timed) as structured content. */
export function ok(text: string, data: Record<string, unknown>, zone: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: withIsoTimes(data, zone),
  };
}

/**
 * Tool-level failure the model can read and correct (not a protocol error).
 * `details` (such as raw validation issues) go only in structured content.
 */
export function fail(message: string, details?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    ...(details ? { structuredContent: { error: message, ...details } } : {}),
  };
}

/** Compact one-line Zod issues: `config.url: Invalid URL; name: Too small`. */
export function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** "99.95%" (two decimals, trailing zeros trimmed). */
export function pct(n: number): string {
  return `${Number(n.toFixed(2))}%`;
}

/** Human duration from seconds: "45s", "12m", "3h 5m", "2d 4h". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
