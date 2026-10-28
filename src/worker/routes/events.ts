import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { homePage } from "../lib/home-page";
import { EVENT_NAMES, type EventName } from "../../shared/events";

/**
 * Landing page click counts, mounted at /api/events (docs/LANDING_AND_LOGIN_PLAN.md,
 * item 1.0). Cloudflare Web Analytics counts page views but has no custom
 * events, so the few clicks the plan measures are counted here.
 *
 * Private by design: a fixed list of event names, daily totals only (migration
 * 0012), no cookies, and nothing about the visitor is stored. The per-visitor
 * rate limit uses the Workers Rate Limiting binding (EVENT_LIMITER), which keeps
 * its counters in Cloudflare's memory, not in this database.
 *
 * Cheap on Cloudflare's free plan: one upsert per counted event, the page sends
 * each event at most once per page view, and a name stops counting (and
 * writing) for the day at DAILY_CAP.
 *
 * Only a HOME_PAGE="landing" install counts anything; elsewhere both routes
 * answer 404, like the waitlist.
 */
export const events = new Hono<AppEnv>();

export { EVENT_NAMES, type EventName };

/** Past this many a day, one event stops counting, so a flood can't run up writes. */
export const DAILY_CAP = 2000;

/** How many days the admin view sums. */
const WINDOW_DAYS = 30;

export const eventSchema = z.object({ name: z.enum(EVENT_NAMES) });

/** The UTC day key for `now`, e.g. "2026-10-28". */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Add one to today's count for `name`. A single statement that writes nothing
 * once the day's cap is reached. Callers check the install is a landing one.
 */
export async function countEvent(env: Env, name: EventName, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO page_events (day, name, count) VALUES (?, ?, 1)
     ON CONFLICT(day, name) DO UPDATE SET count = count + 1 WHERE count < ?`,
  )
    .bind(dayKey(now), name, DAILY_CAP)
    .run();
}

events.post("/", async (c) => {
  if (homePage(c.env) !== "landing") return c.json({ error: "not_found" }, 404);

  // Only this install's own pages count. Browsers send Origin on every POST.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);

  // sendBeacon posts text/plain, so read the body as text whatever its type.
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    body = undefined;
  }
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "unknown_event" }, 400);

  if (c.env.EVENT_LIMITER) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await c.env.EVENT_LIMITER.limit({ key: ip });
    if (!success) return c.json({ error: "rate_limited" }, 429);
  }

  await countEvent(c.env, parsed.data.name);
  return c.body(null, 204);
});

export interface EventTotals {
  name: EventName;
  last7: number;
  last30: number;
}

/** Admin: each event's total over the last 7 and 30 days (today included). */
events.get("/", requireAuth, async (c) => {
  if (homePage(c.env) !== "landing") return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const since30 = dayKey(now - (WINDOW_DAYS - 1) * 86_400_000);
  const since7 = dayKey(now - 6 * 86_400_000);
  const { results } = await c.env.DB.prepare(
    `SELECT name,
            SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS last7,
            SUM(count) AS last30
       FROM page_events
      WHERE day >= ?
      GROUP BY name`,
  )
    .bind(since7, since30)
    .all<{ name: string; last7: number; last30: number }>();
  const byName = new Map((results ?? []).map((r) => [r.name, r]));
  const totals: EventTotals[] = EVENT_NAMES.map((name) => ({
    name,
    last7: byName.get(name)?.last7 ?? 0,
    last30: byName.get(name)?.last30 ?? 0,
  }));
  return c.json({ dailyCap: DAILY_CAP, totals });
});
