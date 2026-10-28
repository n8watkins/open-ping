import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Env } from "../types";

// The outbound check itself is not under test here: stub it as an instant 200.
vi.mock("../checks/http", () => ({
  runHttpCheck: vi.fn(async () => ({ statusCode: 200, durationMs: 5 })),
}));

const { isItDown } = await import("./is-it-down");

/** A D1 stand-in for the rate limiter's upsert: counts hits per key. */
function fakeEnv(): Env {
  const counts = new Map<string, number>();
  const DB = {
    prepare: () => ({
      bind: (key: string) => ({
        first: async () => {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return { count };
        },
        // The limiter's occasional clean-up of old windows.
        run: async () => ({}),
      }),
    }),
  };
  return { DB } as unknown as Env;
}

function app() {
  const a = new Hono<AppEnv>();
  a.route("/", isItDown);
  return a;
}

const check = (a: Hono<AppEnv>, env: Env, url: string, ip: string) =>
  a.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ url }),
    },
    env,
  );

describe("POST /api/tools/is-it-down rate limits", () => {
  it("caps checks of one host across many IPs, so it can't flood a single site", async () => {
    const a = app();
    const env = fakeEnv();
    const statuses: number[] = [];
    // 40 different callers (each well under its own 15/min), one target.
    for (let i = 0; i < 40; i++) {
      statuses.push((await check(a, env, "https://target.example/", `203.0.113.${i}`)).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });

  it("counts a host the same whatever its case or path", async () => {
    const a = app();
    const env = fakeEnv();
    for (let i = 0; i < 30; i++) {
      await check(a, env, `https://Target.Example/page-${i}`, `198.51.100.${i}`);
    }
    const res = await check(a, env, "https://target.example/other", "198.51.100.200");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("leaves other hosts alone", async () => {
    const a = app();
    const env = fakeEnv();
    for (let i = 0; i < 30; i++) await check(a, env, "https://busy.example/", `192.0.2.${i}`);
    expect((await check(a, env, "https://quiet.example/", "192.0.2.250")).status).toBe(200);
  });
});
