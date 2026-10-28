import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedEmail, PlatformCapability, SendEmailResult } from "../../shared/hosted-contract";
import type { Env } from "../types";
import { emailConfigured, mailTransport, platformTransport, sendEmail, type OutgoingEmail } from "./mail";

const message: OutgoingEmail = {
  from: "OpenPing <alerts@example.com>",
  to: "owner@example.com",
  subject: "API is down",
  html: "<p>down</p>",
  text: "down",
  category: "alert",
};

function platform(answer: SendEmailResult | Error): PlatformCapability & { sent: HostedEmail[] } {
  const sent: HostedEmail[] = [];
  return {
    sent,
    async sendEmail(m) {
      sent.push(m);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async reportUsage() {},
    async audit() {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("platformTransport", () => {
  it("sends through the platform, which picks the From address", async () => {
    const p = platform({ ok: true, id: "em_1" });
    expect(await platformTransport(p).send(message)).toEqual({ ok: true });
    expect(p.sent).toEqual([
      { to: ["owner@example.com"], subject: "API is down", text: "down", html: "<p>down</p>", category: "alert" },
    ]);
  });

  it("waits for the next UTC day when the daily cap is reached", async () => {
    const p = platform({ ok: false, error: "email_quota_exceeded", message: "cap" });
    const now = Date.UTC(2026, 9, 28, 23, 0, 0);
    expect(await platformTransport(p, () => now).send(message)).toEqual({
      ok: false,
      error: "email_quota_exceeded",
      retryAfterMs: 60 * 60 * 1000,
    });
  });

  it("passes a rejection on, and treats an RPC that throws as unavailable", async () => {
    expect(await platformTransport(platform({ ok: false, error: "email_rejected", message: "bad" })).send(message)).toEqual({
      ok: false,
      error: "email_rejected",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await platformTransport(platform(new Error("rpc failed"))).send(message)).toEqual({
      ok: false,
      error: "email_unavailable",
    });
  });
});

describe("mailTransport", () => {
  it("uses Resend on a plain install, even when something set MAIL_TRANSPORT", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const p = platform({ ok: true, id: "em_1" });
    const env = { RESEND_API_KEY: "re_test", MAIL_TRANSPORT: platformTransport(p) } as unknown as Env;
    expect(await sendEmail(env, message)).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.resend.com/emails");
    expect(p.sent).toEqual([]);
    expect(emailConfigured(env)).toBe(true);
    expect(emailConfigured({} as Env)).toBe(false);
  });

  it("uses only the platform in hosted mode, never the install's own Resend key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = platform({ ok: true, id: "em_1" });
    const env = { HOSTED_MODE: "1", RESEND_API_KEY: "re_test", MAIL_TRANSPORT: platformTransport(p) } as unknown as Env;
    expect(await sendEmail(env, message)).toEqual({ ok: true });
    expect(p.sent).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emailConfigured(env)).toBe(true);

    const bare = { HOSTED_MODE: "1", RESEND_API_KEY: "re_test" } as unknown as Env;
    expect(await mailTransport(bare).send(message)).toEqual({ ok: false, error: "email_unavailable" });
    expect(emailConfigured(bare)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
