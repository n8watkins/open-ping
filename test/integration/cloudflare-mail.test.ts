import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/worker/types";
import { cloudflareTransport, emailConfigured, mailroomTransport, mailTransport, nextUtcDay, parseFrom, type EmailBinding, type MailroomBinding } from "../../src/worker/notifications/mail";
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

describe("mailroomTransport", () => {
  type Sent = Parameters<MailroomBinding["send"]>[0];
  let sent: Sent[] = [];
  let answer: Awaited<ReturnType<MailroomBinding["send"]>> | "throw" = { ok: true, messageId: "mr1" };
  const mailroom: MailroomBinding = {
    async send(request) {
      if (answer === "throw") throw new Error("service down");
      sent.push(request);
      return answer;
    },
  };
  const withMailroom = (extra: Partial<Env> = {}): Env => ({ ...env, EMAIL: binding, MAILROOM: mailroom, ...extra }) as Env;

  beforeEach(() => {
    sent = [];
    answer = { ok: true, messageId: "mr1" };
  });

  it("wins over the EMAIL binding and maps every category to an allowed kind", async () => {
    for (const category of ["alert", "report", "signin", "waitlist"] as const) {
      expect(await mailTransport(withMailroom()).send({ ...message, category })).toEqual({ ok: true });
    }
    expect(outbox).toHaveLength(0);
    expect(sent.map((s) => s.kind)).toEqual(["alert", "report", "signin", "waitlist"]);
  });

  it("sends text, html, the From name and headers, but not the From address", async () => {
    const headers = { "List-Unsubscribe": "<https://x.test/leave>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    await mailTransport(withMailroom()).send({ ...message, headers });
    expect(sent).toEqual([{ kind: "alert", to: "owner@example.com", subject: "API is down", text: "down", html: "<p>down</p>", fromName: "OpenPing", headers }]);
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.join("\n")).not.toContain("example.com");
  });

  it("keeps the local daily cap", async () => {
    const t = Date.UTC(2026, 10, 10, 23, 0, 0);
    const transport = mailroomTransport(withMailroom({ EMAIL_DAILY_CAP: "1" }), () => t);
    expect(await transport.send(message)).toEqual({ ok: true });
    expect(await transport.send(message)).toEqual({ ok: false, error: "email_daily_cap", deferUntil: nextUtcDay(t) });
    expect(sent).toHaveLength(1);
  });

  it("defers a mailroom cap to the next UTC day without spending an attempt", async () => {
    const t = Date.UTC(2026, 10, 10, 12, 0, 0);
    answer = { ok: false, code: "cap_app_month", retryable: false, message: "monthly cap reached" };
    expect(await mailroomTransport(withMailroom(), () => t).send(message)).toEqual({
      ok: false,
      error: "mailroom_cap_app_month: monthly cap reached",
      deferUntil: nextUtcDay(t),
    });
  });

  it("returns other refusals and an unreachable mailroom as errors, with no deferral", async () => {
    answer = { ok: false, code: "kind_not_allowed", retryable: false, message: "nope" };
    expect(await mailTransport(withMailroom()).send(message)).toEqual({ ok: false, error: "mailroom_kind_not_allowed: nope" });
    answer = "throw";
    expect(await mailTransport(withMailroom()).send(message)).toEqual({ ok: false, error: "mailroom_unavailable: service down" });
  });

  it("counts as configured without an EMAIL binding", () => {
    expect(emailConfigured({ ...env, MAILROOM: mailroom } as Env)).toBe(true);
  });
});

describe("parseFrom", () => {
  it("splits a display name from the address", () => {
    expect(parseFrom('"Open Ping" <a@b.co>')).toEqual({ email: "a@b.co", name: "Open Ping" });
    expect(parseFrom("a@b.co")).toEqual({ email: "a@b.co" });
  });
});
