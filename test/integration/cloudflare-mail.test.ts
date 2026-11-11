import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/worker/types";
import { cloudflareTransport, mailTransport, nextUtcDay, parseFrom, type EmailBinding } from "../../src/worker/notifications/mail";
import type { OutgoingEmail } from "../../src/worker/notifications/mail";

/**
 * Cloudflare Email Service as the plain-install transport, with the real D1 for
 * the daily cap and a fake `EMAIL` binding standing in for the send (no real
 * mail leaves the test).
 */

const message: OutgoingEmail = {
  from: "OpenPing <openping@example.com>",
  to: "owner@example.com",
  subject: "API is down",
  html: "<p>down</p>",
  text: "down",
  category: "alert",
};

let outbox: Array<Parameters<EmailBinding["send"]>[0]> = [];
let failNext = false;
let logSpy: { mock: { calls: unknown[][] } };
const binding: EmailBinding = {
  async send(m) {
    if (failNext) {
      failNext = false;
      throw new Error("sender not allowed");
    }
    outbox.push(m);
    return { messageId: `m${outbox.length}` };
  },
};
const envWith = (extra: Partial<Env> = {}): Env => ({ ...env, EMAIL: binding, ...extra }) as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  outbox = [];
  failNext = false;
  await env.DB.prepare("DELETE FROM rate_limits").run();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("cloudflareTransport", () => {
  it("sends through the binding with the From name split out, and logs the category only", async () => {
    expect(await mailTransport(envWith()).send(message)).toEqual({ ok: true });
    expect(outbox).toEqual([
      { to: "owner@example.com", from: { email: "openping@example.com", name: "OpenPing" }, subject: "API is down", html: "<p>down</p>", text: "down" },
    ]);
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toContain(JSON.stringify({ event: "email_sent", category: "alert" }));
    expect(lines.join("\n")).not.toContain("example.com");
  });

  it("counts sends per category for a future admin page", async () => {
    await cloudflareTransport(envWith()).send(message);
    await cloudflareTransport(envWith()).send({ ...message, category: "signin" });
    const rows = await env.DB.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'email-sent:%' ORDER BY key").all<{ key: string; count: number }>();
    const byScope = Object.fromEntries(rows.results.map((r) => [r.key.replace(/:\d+$/, ""), r.count]));
    expect(byScope).toEqual({ "email-sent:alert": 1, "email-sent:all": 2, "email-sent:signin": 1 });
  });

  it("stops at the daily cap and defers to the next UTC day", async () => {
    const t = Date.UTC(2026, 10, 10, 23, 0, 0);
    const transport = cloudflareTransport(envWith({ EMAIL_DAILY_CAP: "2" }), () => t);
    expect(await transport.send(message)).toEqual({ ok: true });
    expect(await transport.send(message)).toEqual({ ok: true });
    expect(await transport.send(message)).toEqual({ ok: false, error: "email_daily_cap", deferUntil: nextUtcDay(t) });
    expect(outbox).toHaveLength(2);
    const next = cloudflareTransport(envWith({ EMAIL_DAILY_CAP: "2" }), () => nextUtcDay(t) + 1);
    expect(await next.send(message)).toEqual({ ok: true });
  });

  it("returns a retryable error when Cloudflare refuses the send", async () => {
    failNext = true;
    expect(await cloudflareTransport(envWith()).send(message)).toEqual({
      ok: false,
      error: "cloudflare_email_error: sender not allowed",
    });
  });

  it("fails cleanly without a binding", async () => {
    expect(await cloudflareTransport({ ...env } as Env).send(message)).toEqual({ ok: false, error: "email_not_configured" });
  });
});

describe("provider choice", () => {
  const fetchSpy = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

  it("defaults to Cloudflare, and keeps Resend for a self-hoster who only has a key", async () => {
    const spy = fetchSpy();
    await mailTransport(envWith()).send(message);
    expect(outbox).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();

    await mailTransport({ ...env, RESEND_API_KEY: "re_test" } as Env).send(message);
    expect(String(spy.mock.calls[0]![0])).toBe("https://api.resend.com/emails");
  });

  it("EMAIL_TRANSPORT picks explicitly when both are set up", async () => {
    const spy = fetchSpy();
    await mailTransport(envWith({ RESEND_API_KEY: "re_test", EMAIL_TRANSPORT: "cloudflare" })).send(message);
    expect(outbox).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    await mailTransport(envWith({ RESEND_API_KEY: "re_test", EMAIL_TRANSPORT: "resend" })).send(message);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("parseFrom", () => {
  it("splits a display name from the address", () => {
    expect(parseFrom('"Open Ping" <a@b.co>')).toEqual({ email: "a@b.co", name: "Open Ping" });
    expect(parseFrom("a@b.co")).toEqual({ email: "a@b.co" });
  });
});
