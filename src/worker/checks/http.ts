import type { HttpConfig } from "../../shared/schemas";
import type { ProbeResult } from "./types";
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

/**
 * Read a response body with a HARD ceiling enforced DURING the read. `res.text()`
 * would buffer the entire (untrusted) body into memory first, so a hostile
 * endpoint could return hundreds of MB and exhaust the Worker's ~128MB isolate
 * before any cap applied. We stream chunks until `maxChars` is reached, then
 * cancel the reader so the remaining bytes are never downloaded — bounding peak
 * memory to ~maxChars plus one chunk.
 */
async function readCappedText(res: Response, maxChars: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxChars);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/** Methods that must never carry a request body. */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/** Maximum redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

export interface HttpCheckResult extends ProbeResult {
  statusCode?: number;
  /** True when the response matches the Render "Service Suspended" signature. */
  suspended?: boolean;
  /** Response text, capped at MAX_BODY_CHARS. */
  body?: string;
  redirected?: boolean;
  finalUrl?: string;
}

/**
 * Detect a Render free-tier "Service Suspended" response. When a free instance's
 * monthly hours are exhausted, Render turns the app off entirely and serves an
 * HTTP 503 carrying an `x-render-routing: suspend…` header and a body titled
 * "Service Suspended". That is a distinct, durable state — the app is off, not
 * merely erroring — so we classify it as `suspended` rather than generic `down`.
 *
 * Signature: status 503 AND (the routing header contains "suspend" OR the body
 * contains "Service Suspended"). Pure + side-effect free so it can be unit-tested
 * directly.
 */
export function isSuspendedResponse(input: {
  statusCode?: number;
  routingHeader?: string | null;
  body?: string;
}): boolean {
  if (input.statusCode !== 503) return false;
  if ((input.routingHeader ?? "").toLowerCase().includes("suspend")) return true;
  return (input.body ?? "").includes("Service Suspended");
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
      // Cross-origin redirect: drop ALL admin-configured and credential headers
      // (Authorization, Cookie, X-Api-Key, …). The redirect target is chosen by
      // the untrusted remote server, so carrying any configured secret header to
      // a different origin would leak it. Stripping only Authorization (as before)
      // missed every other configured secret-bearing header.
      if (next.origin !== prevOrigin) {
        reqHeaders = new Headers();
        // Drop the request body as well. On a 307/308 the method and body are
        // preserved, so without this a secret carried in the body would be
        // re-sent to the server-chosen cross-origin target — the same leak the
        // header stripping above guards against.
        reqBody = undefined;
      }
      currentUrl = next.toString();
      redirected = true;
    }

    // Response-time threshold is measured to the final response (headers), not
    // including the body download.
    durationMs = Date.now() - startedAt;
    finalUrl = res!.url || currentUrl;

    // Read the body for later assertion evaluation; the timer still covers it.
    // The cap is enforced DURING the read (streaming) so an oversized response
    // can't exhaust isolate memory before being truncated.
    try {
      body = await readCappedText(res!, MAX_BODY_CHARS);
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

  // Render free-tier suspension: a 503 with the suspend routing header/body is a
  // distinct outage flavor. The status is already out-of-range (so `ok` is
  // false); we just flag it so the runner can classify it as `suspended`.
  const suspended = isSuspendedResponse({
    statusCode,
    routingHeader: res!.headers.get("x-render-routing"),
    body,
  });

  return {
    ok,
    statusCode,
    durationMs,
    ...(error ? { error } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(degraded ? { degraded } : {}),
    ...(suspended ? { suspended } : {}),
    body,
    redirected,
    finalUrl,
  };
}
