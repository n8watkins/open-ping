import type { Env } from "../types";

/**
 * Generic fixed-window rate limiter backed by the `rate_limits` table
 * (migration 0007). Each distinct `scope` gets an independent counter that
 * resets every window. Used by the public, unauthenticated "Is it down?" tool
 * to cap abuse (per client IP + a global ceiling), but deliberately generic so
 * other public endpoints can reuse it.
 *
 * Model: one D1 row per (scope, window). The row `key` embeds the window index,
 * so a new window always upserts a fresh row starting at 1 — counters reset with
 * no scheduled job. On each hit we increment and compare the post-increment
 * `count` to the cap. Expired rows are reaped opportunistically so the table
 * stays bounded without a cron.
 *
 * The window/key math and the allow/deny decision are pure and exported for
 * unit testing; only `hitRateLimit` touches D1.
 */

/** Default rolling window: one minute. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitDecision {
  /** True when this hit is within the cap (count <= limit). */
  allowed: boolean;
  /** Hits recorded in the current window, including this one. */
  count: number;
  /** The configured cap for this scope. */
  limit: number;
  /** Hits still permitted this window (0 once the cap is reached). */
  remaining: number;
  /** Seconds until the current window rolls over (for a Retry-After header). */
  retryAfterSeconds: number;
}

/** Fixed-window bucket index containing `now` (pure). */
export function windowIndexFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

/** Storage key for `scope` in the window containing `now` (pure). */
export function rateLimitKey(scope: string, now: number, windowMs: number): string {
  return `${scope}:${windowIndexFor(now, windowMs)}`;
}

/**
 * Pure decision from a post-increment `count` — no I/O, so it is unit-testable
 * without D1. `allowed` is true only while the count is within the cap.
 */
export function decideRateLimit(
  count: number,
  limit: number,
  now: number,
  windowMs: number,
): RateLimitDecision {
  const windowEnd = (windowIndexFor(now, windowMs) + 1) * windowMs;
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}

/**
 * Record one hit against `scope` in the current window and return the decision.
 * The upsert-increment is a single round trip (INSERT … ON CONFLICT … RETURNING).
 * A blocked (over-limit) hit still increments, so a flood can't reset itself by
 * hammering the endpoint.
 */
export async function hitRateLimit(
  env: Env,
  scope: string,
  limit: number,
  opts: { now?: number; windowMs?: number } = {},
): Promise<RateLimitDecision> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const key = rateLimitKey(scope, now, windowMs);
  const windowStart = windowIndexFor(now, windowMs) * windowMs;

  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  // Opportunistic reap of long-expired windows keeps the table bounded without a
  // dedicated cron. Best-effort and low-probability — never blocks the request,
  // and only touches rows several windows in the past (never the live one).
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
      .bind(now - windowMs * 5)
      .run()
      .catch(() => {});
  }

  return decideRateLimit(count, limit, now, windowMs);
}
