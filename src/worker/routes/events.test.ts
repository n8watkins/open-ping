import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../types";
import { DAILY_CAP, EVENT_NAMES, dayKey, eventSchema, events } from "./events";

// A database that fails the test if it's touched.
const untouchedDb = new Proxy({}, {
  get() {
    throw new Error("the database must not be used here");
  },
}) as unknown as D1Database;

/** A database that records the one statement the counter runs. */
function recordingDb(calls: { sql: string; args: unknown[] }[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function app() {
  const root = new Hono<AppEnv>();
  root.route("/api/events", events);
  return root;
}

function post(env: Partial<Env>, body: string, headers: Record<string, string> = {}) {
  return app().request(
    "https://openping.test/api/events",
    { method: "POST", headers: { "content-type": "text/plain", ...headers }, body },
    { DB: untouchedDb, ...env } as Env,
  );
}

describe("eventSchema", () => {
  it("takes only names on the list", () => {
    for (const name of EVENT_NAMES) expect(eventSchema.safeParse({ name }).success).toBe(true);
    expect(eventSchema.safeParse({ name: "anything_else" }).success).toBe(false);
    expect(eventSchema.safeParse({}).success).toBe(false);
  });
});

describe("dayKey", () => {
  it("is the UTC calendar day", () => {
    expect(dayKey(Date.UTC(2026, 9, 28, 23, 59))).toBe("2026-10-28");
    expect(dayKey(Date.UTC(2026, 9, 29, 0, 0))).toBe("2026-10-29");
  });
});

describe("the event counter", () => {
  it("is off unless HOME_PAGE is landing, without touching the database", async () => {
    for (const value of [undefined, "status", "true"]) {
      const res = await post({ HOME_PAGE: value }, JSON.stringify({ name: "hero_deploy" }));
      expect(res.status).toBe(404);
    }
  });

  it("rejects unknown names and bad bodies before counting", async () => {
    for (const body of ["", "nope", JSON.stringify({ name: "made_up" }), JSON.stringify({ name: 1 })]) {
      const res = await post({ HOME_PAGE: "landing" }, body);
      expect(res.status).toBe(400);
    }
  });

  it("rejects posts from another site's pages", async () => {
    const res = await post(
      { HOME_PAGE: "landing" },
      JSON.stringify({ name: "hero_deploy" }),
      { origin: "https://elsewhere.example" },
    );
    expect(res.status).toBe(403);
  });

  it("answers 429 when the visitor is over the rate limit, without a write", async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await post({ HOME_PAGE: "landing", EVENT_LIMITER: limiter }, JSON.stringify({ name: "hero_deploy" }));
    expect(res.status).toBe(429);
  });

  it("adds one to today's count with a single capped upsert, storing nothing about the visitor", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    let limitedKey = "";
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        limitedKey = key;
        return { success: true };
      },
    } as unknown as RateLimit;
    const res = await post(
      { HOME_PAGE: "landing", DB: recordingDb(calls), EVENT_LIMITER: limiter },
      JSON.stringify({ name: "pricing_view" }),
      { origin: "https://openping.test", "cf-connecting-ip": "203.0.113.9" },
    );
    expect(res.status).toBe(204);
    expect(limitedKey).toBe("203.0.113.9");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/ON CONFLICT\(day, name\) DO UPDATE SET count = count \+ 1 WHERE count < \?/);
    expect(calls[0]!.args).toEqual([dayKey(Date.now()), "pricing_view", DAILY_CAP]);
    expect(JSON.stringify(calls[0]!.args)).not.toContain("203.0.113.9");
  });
});
