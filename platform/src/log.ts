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
 *   booleans and short lists. An Error becomes its message, never its stack;
 *   a nested object is flattened to JSON text after the redaction below.
 * - secrets are kept out by two rules, applied at every depth:
 *   1. a field whose name looks like a secret (isSecretName: token, secret,
 *      pass, cookie, auth, session, csrf, code, sig, otp, credential,
 *      jwt, private, signing, any *key) is written as "[redacted]";
 *   2. every string, error messages included, is scrubbed (scrubText) of
 *      secrets in query strings (?token=, ?t=, ?code=, ?secret=, ?state=...),
 *      heartbeat ping paths (/hb/<token>), bearer tokens, JWTs, Stripe,
 *      Stripe webhook, Resend and OpenPing API keys, and email addresses.
 *   These are a net under the call sites, which pass ids and counts only
 *   (tenant, account, run, release, Stripe event); a secret in a shape the
 *   rules don't know would still get through, so call sites must not pass one.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | Error | readonly (string | number)[];
export type LogFields = Record<string, LogValue | unknown>;

export interface LogLine {
  event: string;
  level: LogLevel;
  [field: string]: string | number | boolean | null | (string | number)[];
}

/**
 * A field name that may hold a secret, at any depth: tokens, secrets,
 * passwords and passphrases, cookies, auth and authorization headers,
 * sessions, CSRF values, OAuth codes, signatures, one-time codes,
 * credentials, JWTs, private and signing keys, and any name ending in "key".
 */
const SECRET_NAME =
  /(token|secret|pass|cookie|auth|session|csrf|xsrf|^code$|_code$|Code$|sig|otp|credential|jwt|private|signing|bearer|key$|^key|_key|Key[A-Z_]|apikey)/i;
/** Names that match the pattern above but are known not to be secrets. */
const NOT_SECRET = new Set(["emailKey", "errorCode", "idempotency"]);

/**
 * Values that look like secrets wherever they appear, error messages included:
 * secrets in query strings, heartbeat ping paths, bearer tokens, JWTs, and
 * the key formats the platform handles (Stripe, Stripe webhooks, Resend,
 * OpenPing API tokens). Email addresses are customer data, not secrets, but
 * are never logged either.
 */
const SCRUB: [RegExp, string][] = [
  [/([?&#](?:token|t|code|secret|state|key|sig|signature|password|otp|session)=)[^&#\s"'<>]*/gi, "$1[redacted]"],
  [/(\/hb\/)[A-Za-z0-9_-]+/g, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, "[redacted-key]"],
  [/\bwhsec_[A-Za-z0-9+/=]+/g, "[redacted-key]"],
  [/\bopk_[A-Za-z0-9_-]+/g, "[redacted-key]"],
  [/\bre_[A-Za-z0-9_]{8,}/g, "[redacted-key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];
const MAX_TEXT = 300;
const MAX_LIST = 50;
const MAX_DEPTH = 4;
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const REDACTED = "[redacted]";

/** Whether a field of this name is always written as "[redacted]". */
export function isSecretName(name: string): boolean {
  return !NOT_SECRET.has(name) && SECRET_NAME.test(name);
}

/** `text` with every secret-shaped part replaced (see SCRUB). */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out;
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

/** An error's message, short, on one line and scrubbed; anything else as text. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return cut(scrubText(text.replace(/\s+/g, " ")));
}

/** A copy of `value` with secret-named keys redacted and every string scrubbed, at any depth. */
function redactDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value instanceof Error) return errorText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretName(k) ? REDACTED : redactDeep(v, depth + 1);
  return out;
}

function cleanValue(value: unknown): string | number | boolean | null | (string | number)[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return cut(scrubText(value));
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Error) return errorText(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return value.slice(0, MAX_LIST).map((v) => (typeof v === "number" ? v : cut(scrubText(v))));
  }
  // Anything nested is redacted by key and scrubbed first, then flattened to text.
  try {
    return cut(JSON.stringify(redactDeep(value, 0)) ?? String(value));
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
    line[name] = isSecretName(name) && clean !== null ? REDACTED : clean;
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
