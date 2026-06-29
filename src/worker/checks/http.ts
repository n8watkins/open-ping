import type { HttpConfig } from "../../shared/schemas";
import { b64encode } from "../lib/crypto";
import { assertSafeUrl } from "../lib/ssrf";

/**
 * HTTP/API check executor (PRD §6.1): performs a single outbound request and
 * classifies the result. Runs in the Cloudflare Workers runtime — only global
 * `fetch`, `AbortController` and Web Crypto are used; no Node APIs.
 *
 * // TODO(phase-6): SSRF guard (reject loopback/link-local/metadata/private)
 * // happens before this runs.
 */

/** Maximum number of body characters retained for later assertion evaluation. */
const MAX_BODY_CHARS = 1_000_000;

/** Methods that must never carry a request body. */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export interface HttpCheckResult {
  ok: boolean;
  statusCode?: number;
  durationMs: number;
  /** Short machine code: "timeout", "status_out_of_range", "response_too_slow",
   * "network_error", "tls_error", "dns_error". */
  error?: string;
  /** Human-readable detail (safe — never contains secrets). */
  errorMessage?: string;
  /** True when slower than degradedResponseMs but still ok. */
  degraded?: boolean;
  /** Response text, capped at MAX_BODY_CHARS. */
  body?: string;
  redirected?: boolean;
  finalUrl?: string;
}

/**
 * Map a thrown (non-abort) fetch error to a coarse machine code. Refines to
 * "dns_error"/"tls_error" only when the message clearly indicates so, otherwise
 * falls back to "network_error".
 */
function classifyFetchError(err: unknown): {
  error: string;
  errorMessage: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("getaddrinfo") ||
    lower.includes("enotfound") ||
    lower.includes("dns") ||
    lower.includes("could not resolve") ||
    lower.includes("name not resolved") ||
    lower.includes("name_not_resolved")
  ) {
    return { error: "dns_error", errorMessage: message };
  }

  if (
    lower.includes("certificate") ||
    lower.includes("tls") ||
    lower.includes("ssl") ||
    lower.includes("handshake")
  ) {
    return { error: "tls_error", errorMessage: message };
  }

  return { error: "network_error", errorMessage: message };
}

export async function runHttpCheck(
  config: HttpConfig,
  opts?: { warmup?: boolean },
): Promise<HttpCheckResult> {
  // SSRF guard (PRD §19): reject loopback/link-local/metadata/private/credentialed
  // targets before making any outbound request.
  const safe = assertSafeUrl(config.url);
  if (!safe.ok) {
    return {
      ok: false,
      durationMs: 0,
      error: "blocked_url",
      errorMessage: `Target rejected by SSRF guard: ${safe.reason}`,
    };
  }

  const timeoutMs = opts?.warmup ? config.warmupTimeoutMs : config.timeoutMs;

  // Build request headers, then layer auth on top.
  const headers = new Headers();
  for (const { name, value } of config.headers) headers.set(name, value);
  if (config.auth.type === "basic") {
    const encoded = b64encode(
      new TextEncoder().encode(
        `${config.auth.username}:${config.auth.password}`,
      ),
    );
    headers.set("Authorization", `Basic ${encoded}`);
  } else if (config.auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${config.auth.token}`);
  }

  const init: RequestInit = {
    method: config.method,
    headers,
    redirect: config.followRedirects ? "follow" : "manual",
  };
  // GET/HEAD must not carry a body.
  if (config.body !== undefined && !BODYLESS_METHODS.has(config.method)) {
    init.body = config.body;
  }

  const controller = new AbortController();
  init.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(config.url, init);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        durationMs,
        error: "timeout",
        errorMessage: `Request exceeded ${timeoutMs}ms timeout`,
      };
    }
    const { error, errorMessage } = classifyFetchError(err);
    return { ok: false, durationMs, error, errorMessage };
  }
  const durationMs = Date.now() - startedAt;
  clearTimeout(timer);

  const statusCode = res.status;

  // Read the body for later assertion evaluation; never let a read failure
  // abort the whole check.
  let body: string | undefined;
  try {
    const text = await res.text();
    body = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
  } catch {
    body = undefined;
  }

  const { min, max } = config.expectedStatus;
  let ok = statusCode >= min && statusCode <= max;
  let error: string | undefined = ok ? undefined : "status_out_of_range";
  let errorMessage: string | undefined = ok
    ? undefined
    : `Status ${statusCode} outside expected range ${min}-${max}`;

  // A too-slow response is a failure even when the status code is good.
  if (
    ok &&
    config.failResponseMs !== undefined &&
    durationMs > config.failResponseMs
  ) {
    ok = false;
    error = "response_too_slow";
    errorMessage = `Response took ${durationMs}ms (max ${config.failResponseMs}ms)`;
  }

  let degraded: boolean | undefined;
  if (
    ok &&
    config.degradedResponseMs !== undefined &&
    durationMs > config.degradedResponseMs
  ) {
    degraded = true;
  }

  return {
    ok,
    statusCode,
    durationMs,
    ...(error ? { error } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(degraded ? { degraded } : {}),
    body,
    redirected: res.redirected,
    finalUrl: res.url,
  };
}
