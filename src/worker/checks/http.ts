import type { HttpConfig } from "../../shared/schemas";
import { b64encode } from "../lib/crypto";
import { assertSafeUrl } from "../lib/ssrf";

/**
 * HTTP/API check executor (PRD §6.1): performs a single outbound request and
 * classifies the result. Runs in the Cloudflare Workers runtime — only global
 * `fetch`, `AbortController` and Web Crypto are used; no Node APIs.
 *
 * SSRF guard (PRD §19): the initial URL is validated up front and every redirect
 * hop is re-validated, since the Location header is set by the remote server.
 */

/** Maximum number of body characters retained for later assertion evaluation. */
const MAX_BODY_CHARS = 1_000_000;

/** Methods that must never carry a request body. */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/** Maximum redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

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

  const controller = new AbortController();
  let timedOut = false;
  // One timer governs the WHOLE exchange — all redirect hops plus the body
  // read — so a server that stalls the body (slow-loris) still hits the timeout.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = Date.now();
  let res: Response;
  let finalUrl = config.url;
  let redirected = false;
  let durationMs = 0;
  let body: string | undefined;
  try {
    // Manual redirect following: every hop is re-validated against the SSRF
    // guard, since the Location is controlled by the (untrusted) remote server.
    let currentUrl = config.url;
    let method = config.method;
    let reqHeaders = headers;
    let reqBody = config.body;
    let hops = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const init: RequestInit = {
        method,
        headers: reqHeaders,
        redirect: "manual",
        signal: controller.signal,
      };
      if (reqBody !== undefined && !BODYLESS_METHODS.has(method)) {
        init.body = reqBody;
      }

      res = await fetch(currentUrl, init);

      const isRedirect =
        res.status >= 300 && res.status < 400 && res.status !== 304;
      if (!config.followRedirects || !isRedirect) break;

      const location = res.headers.get("location");
      if (!location) break; // 3xx without a target — treat as the final response.

      if (++hops > MAX_REDIRECTS) {
        clearTimeout(timer);
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: "too_many_redirects",
          errorMessage: `Exceeded ${MAX_REDIRECTS} redirects`,
        };
      }

      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        clearTimeout(timer);
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: "network_error",
          errorMessage: "Invalid redirect location",
        };
      }

      const safeHop = assertSafeUrl(next.toString());
      if (!safeHop.ok) {
        clearTimeout(timer);
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: "blocked_url",
          errorMessage: `Redirect target rejected by SSRF guard: ${safeHop.reason}`,
        };
      }

      const prevOrigin = new URL(currentUrl).origin;
      // Match fetch semantics: 303 (and 301/302 on a non-GET) become GET.
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) &&
          method !== "GET" &&
          method !== "HEAD")
      ) {
        method = "GET";
        reqBody = undefined;
      }
      // Never carry Authorization to a different origin (avoids leaking creds
      // to a redirect target).
      if (next.origin !== prevOrigin && reqHeaders.has("Authorization")) {
        reqHeaders = new Headers(reqHeaders);
        reqHeaders.delete("Authorization");
      }
      currentUrl = next.toString();
      redirected = true;
    }

    // Response-time threshold is measured to the final response (headers), not
    // including the body download.
    durationMs = Date.now() - startedAt;
    finalUrl = res!.url || currentUrl;

    // Read the body for later assertion evaluation; the timer still covers it.
    try {
      const text = await res!.text();
      body = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
    } catch (err) {
      if (timedOut) throw err; // a stalled body that hit the timeout is a timeout
      body = undefined;
    }
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      return {
        ok: false,
        durationMs: elapsed,
        error: "timeout",
        errorMessage: `Request exceeded ${timeoutMs}ms timeout`,
      };
    }
    const { error, errorMessage } = classifyFetchError(err);
    return { ok: false, durationMs: elapsed, error, errorMessage };
  }
  clearTimeout(timer);

  const statusCode = res!.status;

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
    redirected,
    finalUrl,
  };
}
