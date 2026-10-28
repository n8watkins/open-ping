import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import { DAILY_CAP, dayKey } from "../../src/worker/routes/events";

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";

function count(name: string, ip = "10.1.0.1"): Promise<Response> {
  // The way the landing page sends it: sendBeacon's text/plain JSON.
  return exports.default.fetch(`${ORIGIN}/api/events`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", "cf-connecting-ip": ip, origin: ORIGIN },
    body: JSON.stringify({ name }),
  });
}

async function stored(name: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT count FROM page_events WHERE day = ? AND name = ?")
    .bind(dayKey(Date.now()), name)
    .first<{ count: number }>();
  return row?.count;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("landing click counts", () => {
  it("tells the app this install's home is the landing page", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/auth/status`);
    expect(((await res.json()) as { homePage: string }).homePage).toBe("landing");
  });

  it("keeps one daily total per event, and nothing about the visitor", async () => {
    expect((await count("hero_deploy")).status).toBe(204);
    expect((await count("hero_deploy", "10.1.0.2")).status).toBe(204);
    expect((await count("pricing_view")).status).toBe(204);
    expect(await stored("hero_deploy")).toBe(2);
    expect(await stored("pricing_view")).toBe(1);

    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('page_events')").all<{ name: string }>();
    expect(columns.results.map((c) => c.name).sort()).toEqual(["count", "day", "name"]);
  });

  it("stops counting an event for the day at the cap", async () => {
    await env.DB.prepare("INSERT INTO page_events (day, name, count) VALUES (?, 'cta_deploy', ?)")
      .bind(dayKey(Date.now()), DAILY_CAP)
      .run();
    expect((await count("cta_deploy")).status).toBe(204);
    expect(await stored("cta_deploy")).toBe(DAILY_CAP);
  });

  it("rate limits one visitor", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await count("hero_tools", "10.9.9.9")).status);
    expect(statuses).toContain(429);
    expect(await stored("hero_tools")).toBeLessThanOrEqual(30);
  });

  it("shows the admin 7- and 30-day totals for every event, and nobody else", async () => {
    const anon = await exports.default.fetch(`${ORIGIN}/api/events`);
    expect(anon.status).toBe(401);

    const res = await exports.default.fetch(`${ORIGIN}/api/events`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dailyCap: number; totals: { name: string; last7: number; last30: number }[] };
    expect(body.dailyCap).toBe(DAILY_CAP);
    expect(body.totals.find((t) => t.name === "hero_deploy")).toEqual({ name: "hero_deploy", last7: 2, last30: 2 });
    expect(body.totals.find((t) => t.name === "install_view")).toEqual({ name: "install_view", last7: 0, last30: 0 });
  });
});
