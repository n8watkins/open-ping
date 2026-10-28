import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../types";
import { csvField, waitlist, waitlistSchema } from "./waitlist";

// A database that fails the test if it's touched.
const untouchedDb = new Proxy({}, {
  get() {
    throw new Error("the database must not be used here");
  },
}) as unknown as D1Database;

function app() {
  const root = new Hono<AppEnv>();
  root.route("/api/waitlist", waitlist);
  return root;
}

function post(env: Partial<Env>, body: unknown) {
  return app().request(
    "/api/waitlist",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { DB: untouchedDb, ...env } as Env,
  );
}

describe("waitlistSchema", () => {
  it("trims and lowercases a valid email", () => {
    expect(waitlistSchema.parse({ email: "  A@B.Co " }).email).toBe("a@b.co");
  });
  it("rejects anything that isn't an email, or is too long", () => {
    expect(waitlistSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(waitlistSchema.safeParse({ email: `${"a".repeat(250)}@b.co` }).success).toBe(false);
    expect(waitlistSchema.safeParse({}).success).toBe(false);
  });
});

describe("the waitlist route", () => {
  it("is off unless WAITLIST_ENABLED is true, without touching the database", async () => {
    for (const value of [undefined, "false", "1", "TRUE"]) {
      const res = await post({ WAITLIST_ENABLED: value }, { email: "a@b.co" });
      expect(res.status).toBe(404);
    }
  });

  it("drops a honeypot sign-up before rate limiting or storing anything", async () => {
    const res = await post({ WAITLIST_ENABLED: "true" }, { email: "a@b.co", website: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a bad body with 400", async () => {
    const res = await post({ WAITLIST_ENABLED: "true" }, { email: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("csvField", () => {
  it("leaves plain values alone and quotes the rest", () => {
    expect(csvField("a@b.co")).toBe("a@b.co");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
  });

  it("keeps a spreadsheet from running a value as a formula", () => {
    expect(csvField("=HYPERLINK(\"https://evil.example\")@x.co")).toBe(`"'=HYPERLINK(""https://evil.example"")@x.co"`);
    for (const start of ["+", "-", "@", "\t", "\r"]) expect(csvField(`${start}1`).replace(/^"/, "").startsWith(`'${start}`)).toBe(true);
    expect(csvField("a-b@example.com")).toBe("a-b@example.com");
  });
});
