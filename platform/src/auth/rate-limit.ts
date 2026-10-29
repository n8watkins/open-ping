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
  /** Wrong codes for one address in a day, across all its sign-ins; past it, only the link works. */
  codeFailuresPerAddress: { scope: "signin-code-fail:address", limit: 10, windowMs: DAY },
  passkeyStartPerIp: { scope: "signin-passkey-start:ip", limit: 60, windowMs: 10 * MINUTE },
  passkeyPerIp: { scope: "signin-passkey:ip", limit: 30, windowMs: 10 * MINUTE },
  githubPerIp: { scope: "signin-github:ip", limit: 30, windowMs: 10 * MINUTE },
  signUpPerIp: { scope: "signup:ip", limit: 5, windowMs: DAY },
  signUpGlobal: { scope: "signup:all", limit: 300, windowMs: DAY },
  /** The owner's changes in the admin console (B6): plenty for a person, a ceiling for a stolen session. */
  adminAction: { scope: "admin:account", limit: 120, windowMs: HOUR },
  /** Support sign-ins into customers' OpenPings, on top of adminAction. */
  adminSupport: { scope: "admin-support:account", limit: 20, windowMs: HOUR },
  /** A customer's exports of their OpenPing (B7): each one is a D1 export, which pauses its database briefly. */
  exportPerAccount: { scope: "export:account", limit: 3, windowMs: DAY },
  /** Starting a change of the sign-in email (each one emails the new address). */
  emailChangePerAccount: { scope: "email-change:account", limit: 5, windowMs: DAY },
  /** Showing a customer their MASTER_KEY. */
  keyRevealPerAccount: { scope: "key-reveal:account", limit: 5, windowMs: DAY },
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

/**
 * Hits the rules in order and stops at the first that refuses, so a refused
 * request counts only against the rule that refused it. Callers put the
 * narrow rules (an address, an IP) before the wide one (everyone): one IP
 * hammering away is stopped by its own rule and never uses up the global
 * budget that everyone else shares.
 */
export async function hitInOrder(db: D1Database, hits: [RateLimitRule, string][], now: number): Promise<RateLimitDecision | null> {
  for (const [rule, subject] of hits) {
    const decision = await hit(db, rule, subject, now);
    if (!decision.allowed) return decision;
  }
  return null;
}

/** True when `subject` is already over `rule` in this window (counts nothing). */
export async function isOverLimit(db: D1Database, rule: RateLimitRule, subject: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE key = ?")
    .bind(rateLimitKey(`${rule.scope}:${subject}`, now, rule.windowMs))
    .first<{ count: number }>();
  return (row?.count ?? 0) >= rule.limit;
}

/**
 * The subject for per-IP rules: the IPv4 address as is, and an IPv6
 * address's /64, since one customer line or cloud machine usually holds a
 * whole /64 and could otherwise use a new address per request.
 */
export function ipSubject(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  const value = ip.trim().toLowerCase();
  if (!value.includes(":")) return value;
  const [head = "", tail = ""] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return value;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Old windows, for the cron's cleanup: nothing newer than a day is touched. */
export function rateLimitCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 2 * DAY);
}
