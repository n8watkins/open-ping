import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import { WAITLIST_PER_IP_LIMIT } from "../../src/worker/routes/waitlist";
import { RATE_LIMIT_WINDOW_MS } from "../../src/worker/db/rate-limit";

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";

function join(email: string, ip: string, extra: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/api/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin: "https://someone-else.example" },
    body: JSON.stringify({ email, ...extra }),
  });
}

function admin(path: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("the Hosted waitlist", () => {
  it("has its table after migrations", async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'waitlist'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("waitlist");
  });

  it("takes an email from any origin, stores it once, lowercased", async () => {
    const first = await join("  Person@Example.COM ", "10.0.0.1");
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(await first.json()).toEqual({ ok: true });

    // Joining again answers the same, so the form can't be used to test addresses.
    const again = await join("person@example.com", "10.0.0.1");
    expect(await again.json()).toEqual({ ok: true });

    const rows = await env.DB.prepare("SELECT email FROM waitlist WHERE email = ?")
      .bind("person@example.com")
      .all<{ email: string }>();
    expect(rows.results).toHaveLength(1);
  });

  it("answers a cross-origin preflight", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/waitlist`, {
      method: "OPTIONS",
      headers: { origin: "https://someone-else.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("rejects a bad email and quietly drops honeypot sign-ups", async () => {
    expect((await join("not-an-email", "10.0.0.2")).status).toBe(400);

    const bot = await join("bot@example.com", "10.0.0.2", { website: "https://spam.example" });
    expect(await bot.json()).toEqual({ ok: true });
    const stored = await env.DB.prepare("SELECT 1 FROM waitlist WHERE email = 'bot@example.com'").first();
    expect(stored).toBeNull();
  });

  it("rate limits one address after a handful of tries", async () => {
    // The limiter counts per fixed one-minute window; a burst that straddles a
    // window boundary starts a fresh count halfway and never reaches the cap.
    const untilNextWindow = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
    if (untilNextWindow < 5_000) await new Promise((r) => setTimeout(r, untilNextWindow + 50));
    const ip = "10.0.0.3";
    for (let i = 0; i < WAITLIST_PER_IP_LIMIT; i++) {
      expect((await join(`burst${i}@example.com`, ip)).status).toBe(200);
    }
    const limited = await join("one-too-many@example.com", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("shows the list and a CSV to the admin only", async () => {
    expect((await exports.default.fetch(`${ORIGIN}/api/waitlist`)).status).toBe(401);
    expect((await exports.default.fetch(`${ORIGIN}/api/waitlist/export.csv`)).status).toBe(401);

    const list = await admin("/api/waitlist");
    expect(list.status).toBe(200);
    const body = await list.json<{ count: number; entries: { email: string; created_at: number }[] }>();
    expect(body.count).toBeGreaterThanOrEqual(1 + WAITLIST_PER_IP_LIMIT);
    expect(body.entries.map((e) => e.email)).toContain("person@example.com");

    const csv = await admin("/api/waitlist/export.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toBe("email,joined_at");
    expect(text).toContain("person@example.com,");
  });
});
