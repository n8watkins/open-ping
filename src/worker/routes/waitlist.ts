import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { hitRateLimit } from "../db/rate-limit";
import { getSetting } from "../db/settings";
import { newId } from "../lib/ids";
import { emailConfigured, sendEmail } from "../notifications/mail";

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
 * email only, a honeypot field, per-IP and global rate limits, and the same
 * answer whether or not the address was already on the list, so it can't be
 * used to test addresses. GET / and GET /export.csv are admin-only.
 */
export const waitlist = new Hono<AppEnv>();

/** Per-client-IP cap: 5 sign-ups a minute. */
export const WAITLIST_PER_IP_LIMIT = 5;
/** Global ceiling across all callers in the same minute (abuse backstop). */
export const WAITLIST_GLOBAL_LIMIT = 60;
/** Latest entries returned to the admin view; the CSV has them all. */
const ADMIN_LIST_LIMIT = 50;

const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";

/**
 * The sign-up body. `website` is the honeypot: hidden from people, so only a
 * bot fills it in.
 */
export const waitlistSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  website: z.string().max(200).optional(),
});

export function waitlistEnabled(env: AppEnv["Bindings"]): boolean {
  return env.WAITLIST_ENABLED === "true";
}

/** Cross-origin access for the public sign-up (any landing page may post). */
function allowCrossOrigin(c: Context<AppEnv>) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "86400");
}

waitlist.options("/", (c) => {
  allowCrossOrigin(c);
  return c.body(null, 204);
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
  const globalHit = await hitRateLimit(c.env, "wl:global", WAITLIST_GLOBAL_LIMIT);
  if (!globalHit.allowed) {
    c.header("Retry-After", String(globalHit.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  const email = parsed.data.email;
  const inserted = await c.env.DB.prepare(
    `INSERT INTO waitlist (id, email, created_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO NOTHING RETURNING id`,
  )
    .bind(newId("wl"), email, Date.now())
    .first<{ id: string }>();

  // A confirmation for new sign-ups only, when email is set up. Sent after the
  // response so a slow mail provider can't delay it, and its result is ignored.
  if (inserted && emailConfigured(c.env)) {
    const send = async () => {
      const from = (await getSetting(c.env, "email_from")) || DEFAULT_FROM;
      await sendEmail(c.env, {
        from,
        category: "waitlist",
        to: email,
        subject: "You're on the OpenPing Hosted waitlist",
        text: [
          "Thanks for joining the OpenPing Hosted waitlist.",
          "",
          "I'll email you once, when Hosted opens, with early pricing.",
          "Nothing else. To be taken off the list, reply to this email.",
          "",
          "Until then, OpenPing is free to run in your own Cloudflare account: https://openping.n8builds.dev/install",
        ].join("\n"),
      });
    };
    const task = send().catch(() => {});
    try {
      c.executionCtx.waitUntil(task);
    } catch {
      await task;
    }
  }

  return c.json({ ok: true });
});

waitlist.get("/", requireAuth, async (c) => {
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    "SELECT email, created_at FROM waitlist ORDER BY created_at DESC LIMIT ?",
  )
    .bind(ADMIN_LIST_LIMIT)
    .all<{ email: string; created_at: number }>();
  return c.json({ count: total?.n ?? 0, entries: results ?? [] });
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

waitlist.get("/export.csv", requireAuth, async (c) => {
  if (!waitlistEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT email, created_at FROM waitlist ORDER BY created_at ASC",
  ).all<{ email: string; created_at: number }>();
  const lines = ["email,joined_at"];
  for (const row of results ?? []) {
    lines.push(`${csvField(row.email)},${new Date(row.created_at).toISOString()}`);
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="openping-waitlist.csv"');
  return c.body(lines.join("\n") + "\n");
});
