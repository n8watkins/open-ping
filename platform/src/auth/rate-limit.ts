/**
 * Fixed-window rate limits for sign-up and sign-in, in the platform's
 * `rate_limits` table (the same shape as OpenPing's, migration 0001), using
 * OpenPing's own window and decision rules so both behave alike.
 */

import { decideRateLimit, rateLimitKey, windowIndexFor, type RateLimitDecision } from "../../../src/worker/db/rate-limit";

export type { RateLimitDecision };

export interface RateLimitRule {
  /** What is counted, e.g. "signin-email:ip". The subject is appended. */
  scope: string;
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Starting values: generous for a person, tight for a script. The per-email
 * rules stop one address being flooded with mail; the global ones bound the
 * cost of an attack from many addresses.
 */
export const LIMITS = {
  emailPerAddress: { scope: "signin-email:address", limit: 5, windowMs: HOUR },
  emailPerIp: { scope: "signin-email:ip", limit: 20, windowMs: HOUR },
  emailGlobal: { scope: "signin-email:all", limit: 1_000, windowMs: HOUR },
  codePerIp: { scope: "signin-code:ip", limit: 30, windowMs: 10 * MINUTE },
  linkPerIp: { scope: "signin-link:ip", limit: 30, windowMs: 10 * MINUTE },
  passkeyPerIp: { scope: "signin-passkey:ip", limit: 30, windowMs: 10 * MINUTE },
  githubPerIp: { scope: "signin-github:ip", limit: 30, windowMs: 10 * MINUTE },
  signUpPerIp: { scope: "signup:ip", limit: 5, windowMs: DAY },
  signUpGlobal: { scope: "signup:all", limit: 300, windowMs: DAY },
} as const satisfies Record<string, RateLimitRule>;

/** Records one hit against `rule` for `subject` and answers whether it is allowed. */
export async function hit(db: D1Database, rule: RateLimitRule, subject: string, now: number): Promise<RateLimitDecision> {
  const key = rateLimitKey(`${rule.scope}:${subject}`, now, rule.windowMs);
  const windowStart = windowIndexFor(now, rule.windowMs) * rule.windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return decideRateLimit(row?.count ?? 1, rule.limit, now, rule.windowMs);
}

/** Hits every rule (all of them count, even after one refuses) and answers the first refusal, if any. */
export async function hitAll(
  db: D1Database,
  hits: [RateLimitRule, string][],
  now: number,
): Promise<RateLimitDecision | null> {
  const decisions = await Promise.all(hits.map(([rule, subject]) => hit(db, rule, subject, now)));
  return decisions.find((d) => !d.allowed) ?? null;
}

/** Old windows, for the cron's cleanup: nothing newer than a day is touched. */
export function rateLimitCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 2 * DAY);
}
