/**
 * The platform's log lines (build plan, C4): one structured object per event,
 * so Workers Logs indexes every field and the owner can filter by any of them
 * in the Query Builder (`event = "schedule.no_answer"`, `tenant = "..."`).
 * https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects
 *
 * Every line has the same shape:
 *
 *   { event: "<area>.<what>", level: "info" | "warn" | "error", ...fields }
 *
 * - `event` is dotted lowercase, the area first: provision, schedule, billing,
 *   release, lifecycle, mail, export, dispatch, admin, signin, health, cron.
 *   docs/hosted/OBSERVABILITY.md lists every event.
 * - `level` matches the console method, so the dashboard shows the right
 *   severity: info is console.log, warn console.warn, error console.error.
 * - fields are flat and small: strings (cut at 300 characters), numbers,
 *   booleans and short lists. An Error becomes its message, never its stack.
 * - never a secret: a field whose name looks like one (token, secret, key,
 *   password, cookie, authorization) is written as "[redacted]", whatever the
 *   caller passed, so a slip in a call site can't leak one into the logs.
 *   Ids (tenant, account, run, release, Stripe event) and counts are fine.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | Error | readonly (string | number)[];
export type LogFields = Record<string, LogValue | unknown>;

export interface LogLine {
  event: string;
  level: LogLevel;
  [field: string]: string | number | boolean | null | (string | number)[];
}

/** A field name that may hold a secret. `emailKey` and `idempotency` are not secrets; they're spelled so they don't match. */
const SECRET_NAME = /(token|secret|password|passwd|cookie|authorization|api_?key|private|master_?key|signing|^key$|jwt)/i;
const MAX_TEXT = 300;
const MAX_LIST = 50;
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** An error's message, short and on one line; anything else as text. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return text.replace(/\s+/g, " ").slice(0, MAX_TEXT);
}

function cleanValue(value: unknown): string | number | boolean | null | (string | number)[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 3)}...` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Error) return errorText(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST).map((v) => (typeof v === "number" ? v : String(v).slice(0, MAX_TEXT)));
  }
  // Objects are flattened to text, so a nested secret can't slip through as an indexed field.
  try {
    return cleanValue(JSON.stringify(value) ?? String(value)) as string;
  } catch {
    return "[unserializable]";
  }
}

/** The line `log` writes, built separately so tests can check it without the console. */
export function logLine(level: LogLevel, event: string, fields: LogFields = {}): LogLine {
  const line: LogLine = { event: EVENT_NAME.test(event) ? event : `invalid.${event.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`, level };
  for (const [name, value] of Object.entries(fields)) {
    if (name === "event" || name === "level") continue;
    const clean = cleanValue(value);
    if (clean === undefined) continue;
    line[name] = SECRET_NAME.test(name) && clean !== null ? "[redacted]" : clean;
  }
  return line;
}

/** Where lines go; tests swap it to collect them. */
let sink: (line: LogLine) => void = (line) => {
  if (line.level === "error") console.error(line);
  else if (line.level === "warn") console.warn(line);
  else console.log(line);
};

/** Tests only: collect lines instead of printing them; answers the function that puts the console back. */
export function captureLogs(collect: (line: LogLine) => void): () => void {
  const previous = sink;
  sink = collect;
  return () => {
    sink = previous;
  };
}

function write(level: LogLevel, event: string, fields?: LogFields): void {
  try {
    sink(logLine(level, event, fields));
  } catch {
    // Logging never breaks the work it describes.
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
