import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { httpConfigSchema } from "../../shared/schemas";
import { assertSafeUrl } from "../lib/ssrf";
import { runHttpCheck } from "../checks/http";
import { hitRateLimit } from "../db/rate-limit";

/**
 * Public, UNAUTHENTICATED "Is it down?" tool. Mounted by the integrator at
 * /api/tools/is-it-down. Given a user-supplied URL it performs a single GET and
 * reports ONLY reachability — never the response body or headers, so it can't be
 * abused as a content proxy.
 *
 * Because it fetches arbitrary URLs on behalf of anonymous callers, two guards
 * are mandatory and applied before any outbound request:
 *  - SSRF: `assertSafeUrl` rejects loopback/private/link-local/metadata targets
 *    and credentialed URLs (400 blocked_url). runHttpCheck additionally
 *    re-validates every redirect hop.
 *  - Rate limiting: a fixed-window counter in D1 caps requests per client IP and
 *    enforces a global ceiling (429 rate_limited).
 */
export const isItDown = new Hono<AppEnv>();

/**
 * Request body validation. Mirrors `httpConfigSchema.url` (src/shared/schemas):
 * http(s) only, max 2048 chars.
 */
const requestSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => {
      try {
        return /^https?:$/.test(new URL(u).protocol);
      } catch {
        return false;
      }
    }, "url must be http(s)"),
});

/** Per-client-IP cap: 15 checks / rolling minute. */
const PER_IP_LIMIT = 15;
/** Global ceiling across all callers in the same window (abuse backstop). */
const GLOBAL_LIMIT = 300;
/** Short outbound timeout — this is a liveness probe, not a full monitor. */
const CHECK_TIMEOUT_MS = 10_000;
/** Fallback bucket when Cloudflare doesn't provide a client IP (e.g. local dev). */
const UNKNOWN_IP = "unknown";

export interface IsItDownResponse {
  up: boolean;
  status: number | null;
  durationMs: number;
  error?: string;
}

isItDown.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_url" }, 400);
  }

  // SSRF guard up front: reject internal/loopback/private/metadata/credentialed
  // targets before spending a rate-limit slot or making any outbound request.
  const safe = assertSafeUrl(parsed.data.url);
  if (!safe.ok) {
    return c.json({ error: "blocked_url" }, 400);
  }

  // Rate limit: per client IP first, then a global ceiling. Both are fixed
  // one-minute windows counted in D1. Run sequentially so the two writes don't
  // contend on the same D1 session.
  const ip = c.req.header("cf-connecting-ip") ?? UNKNOWN_IP;
  const ipHit = await hitRateLimit(c.env, `iid:ip:${ip}`, PER_IP_LIMIT);
  const globalHit = await hitRateLimit(c.env, "iid:global", GLOBAL_LIMIT);
  if (!ipHit.allowed || !globalHit.allowed) {
    c.header(
      "Retry-After",
      String(Math.max(ipHit.retryAfterSeconds, globalHit.retryAfterSeconds)),
    );
    return c.json({ error: "rate_limited" }, 429);
  }

  // Reuse the production HTTP executor with a minimal GET config. followRedirects
  // is on; http.ts re-validates each redirect hop against the SSRF guard.
  // Parsing through httpConfigSchema fills in all the executor's expected
  // defaults (headers, auth, expectedStatus, warmupTimeoutMs, …).
  const config = httpConfigSchema.parse({
    url: parsed.data.url,
    method: "GET",
    timeoutMs: CHECK_TIMEOUT_MS,
    followRedirects: true,
  });

  const result = await runHttpCheck(config);

  const status = result.statusCode ?? null;
  // "Up" = the server answered with a non-5xx HTTP status. A 5xx, or any
  // connection/DNS/timeout failure (no status at all), is reported as down. Only
  // reachability leaves this handler — never the body or headers.
  const up = status !== null && status < 500;

  const response: IsItDownResponse = {
    up,
    status,
    durationMs: result.durationMs,
  };
  if (!up) {
    response.error =
      result.error ?? (status !== null ? "server_error" : "unreachable");
  }
  return c.json(response);
});
