import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { hitRateLimit } from "../db/rate-limit";
import { getSetting } from "../db/settings";
import { sha256hex } from "../lib/ids";
import { defaultFrom, emailConfigured, sendEmail } from "../notifications/mail";
import { renderConfirmEmail } from "../notifications/waitlist-email";
import { issueLinks, startSignup, waitlistSummary } from "../db/waitlist";
import { turnstileSiteKey, verifyTurnstile } from "../lib/turnstile";

/**
 * The OpenPing Hosted waitlist, mounted at /api/waitlist (docs/HOSTED_PLAN.md,
 * stage 1).
 *
 * Every install serves the same landing page, so the page always posts to the
 * canonical install (openping.n8builds.dev). Only an install with the
 * WAITLIST_ENABLED var set to "true" accepts entries; everywhere else these
 * routes answer 404 and the table stays empty.
 *
 * POST / is public and cross-origin (another install's landing page posts here):
 * an email, a honeypot field, Turnstile (when its keys are set), per-IP and
 * global rate limits, and the same answer whether or not the address was already
 * on the list, so it can't be used to test addresses. It is double opt-in: the
 * row starts pending and a confirm email (links in routes/waitlist-pages.ts)
 * turns it into a confirmed one; a row not confirmed in seven days is deleted.
 * GET /config tells the form its Turnstile site key. GET / and GET /export.csv
 * are admin-only and count confirmed rows (pending ones separately).
 */
export const waitlist = new Hono<AppEnv>();

/** Per-client-IP cap: 5 sign-ups a minute. */
export const WAITLIST_PER_IP_LIMIT = 5;
/** Global ceiling across all callers in the same minute (abuse backstop). */
export const WAITLIST_GLOBAL_LIMIT = 60;
/** Latest entries returned to the admin view; the CSV has them all. */
const ADMIN_LIST_LIMIT = 50;
/**
 * Confirm emails per UTC day, so a flood of sign-ups can't use up the install's
 * daily email allowance (EMAIL_DAILY_CAP, shared with alerts). Past it a row
 * is still stored, pending, with no email.
 */
export const WAITLIST_DAILY_EMAIL_LIMIT = 40;
/** Confirm emails to one address per UTC day (a re-sign-up resends the link). */
export const WAITLIST_PER_ADDRESS_DAILY_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The sign-up body. `website` is the honeypot: hidden from people, so only a
 * bot fills it in.
 */
export const waitlistSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  website: z.string().max(200).optional(),
  /** The Turnstile token (`cf-turnstile-response`), when the form showed the widget. */
  turnstile: z.string().max(2048).optional(),
});

export function waitlistEnabled(env: AppEnv["Bindings"]): boolean {
  return env.WAITLIST_ENABLED === "true";
}

/** Cross-origin access for the public sign-up (any landing page may post). */
function allowCrossOrigin(c: Context<AppEnv>) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "86400");
}

waitlist.options("/", (c) => {
  allowCrossOrigin(c);
  return c.body(null, 204);
});

/** What the form needs before it posts: the Turnstile site key, or null when the check is off. */
waitlist.get("/config", (c) => {
  allowCrossOrigin(c);
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ turnstileSiteKey: turnstileSiteKey(c.env) });
});

waitlist.post("/", async (c) => {
  allowCrossOrigin(c);
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);

  const parsed = waitlistSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_email" }, 400);

  // A bot filled the hidden field: answer as if it worked, store nothing.
  if (parsed.data.website) return c.json({ ok: true });

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHit = await hitRateLimit(c.env, `wl:ip:${ip}`, WAITLIST_PER_IP_LIMIT);
  if (!ipHit.allowed) {
    c.header("Retry-After", String(ipHit.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }
  // After the per-IP limit (so one client can't make us call Cloudflare in a
  // loop) and before the global one (so bots without a token can't use it up).
  if (!(await verifyTurnstile(c.env, parsed.data.turnstile, ip))) {
    return c.json({ error: "turnstile_failed" }, 400);
  }
  const globalHit = await hitRateLimit(c.env, "wl:global", WAITLIST_GLOBAL_LIMIT);
  if (!globalHit.allowed) {
    c.header("Retry-After", String(globalHit.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  // Everything else runs after the answer, which is the same for a new address,
  // a pending one and a confirmed one, so neither the body nor the time it takes
  // says who is on the list. Its failure is logged without the address.
  const task = signUp(c.env, parsed.data.email, new URL(c.req.url).origin).catch((error) => {
    console.error(JSON.stringify({ event: "waitlist_signup_failed", error: error instanceof Error ? error.message : String(error) }));
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    await task;
  }
  return c.json({ ok: true });
});

/**
 * Stores the sign-up as pending and emails the confirm link. A confirmed address
 * gets nothing (it is already on the list), and a pending one gets a fresh link
 * at most WAITLIST_PER_ADDRESS_DAILY_LIMIT times a day.
 */
async function signUp(env: AppEnv["Bindings"], email: string, origin: string): Promise<void> {
  const now = Date.now();
  const { id, state } = await startSignup(env, email, now);
  if (state === "confirmed" || !emailConfigured(env)) return;
  const address = await hitRateLimit(env, `wl:to:${await sha256hex(email)}`, WAITLIST_PER_ADDRESS_DAILY_LIMIT, { now, windowMs: DAY_MS });
  const daily = address.allowed ? await hitRateLimit(env, "wl:mail", WAITLIST_DAILY_EMAIL_LIMIT, { now, windowMs: DAY_MS }) : address;
  if (!daily.allowed) return;
  const links = await issueLinks(env, id, now);
  const from = (await getSetting(env, "email_from")) || defaultFrom(env);
  const result = await sendEmail(env, { from, category: "waitlist", to: email, ...renderConfirmEmail(origin, links) });
  if (!result.ok) console.error(JSON.stringify({ event: "waitlist_confirm_email_failed", error: result.error }));
}

waitlist.get("/", requireAuth, async (c) => {
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const { confirmed, pending } = await waitlistSummary(c.env, Date.now());
  const { results } = await c.env.DB.prepare(
    "SELECT email, confirmed_at AS created_at FROM waitlist WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT ?",
  )
    .bind(ADMIN_LIST_LIMIT)
    .all<{ email: string; created_at: number }>();
  // count is the confirmed rows; pending ones (not yet confirmed, not yet expired) are counted apart.
  return c.json({ count: confirmed, pending, entries: results ?? [] });
});

/**
 * One CSV field. A value a spreadsheet would run as a formula (starting with
 * = + - @, a tab or a carriage return) gets a leading ' so it opens as text
 * (OWASP, CSV injection); then it is quoted when it holds a comma, quote or
 * line break.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The CSV has the confirmed rows. `?status=all` adds the pending ones (not yet
 * expired) with a status column, to see who hasn't confirmed.
 */
waitlist.get("/export.csv", requireAuth, async (c) => {
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const all = c.req.query("status") === "all";
  const statement = all
    ? c.env.DB.prepare("SELECT email, created_at, confirmed_at FROM waitlist WHERE confirmed_at IS NOT NULL OR expires_at > ? ORDER BY created_at ASC").bind(Date.now())
    : c.env.DB.prepare("SELECT email, created_at, confirmed_at FROM waitlist WHERE confirmed_at IS NOT NULL ORDER BY created_at ASC");
  const { results } = await statement.all<{ email: string; created_at: number; confirmed_at: number | null }>();
  const lines = [all ? "email,status,joined_at" : "email,joined_at"];
  for (const row of results ?? []) {
    const joined = new Date(row.created_at).toISOString();
    lines.push(all ? `${csvField(row.email)},${row.confirmed_at === null ? "pending" : "confirmed"},${joined}` : `${csvField(row.email)},${joined}`);
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="openping-waitlist.csv"');
  return c.body(lines.join("\n") + "\n");
});
