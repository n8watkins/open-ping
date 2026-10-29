import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PLAN_LIMITS, type HostedEmail } from "../../src/shared/hosted-contract";
import { EMAIL_LIMITS, TenantCapability, emailUsageCleanup, emailsToday, hostedEmailProblem, tenantMailFromEnv, utcDay } from "../src/capability";
import { ResendMailer, classifyResendError, isOnDomain, mailProblem, mailerFromEnv, tenantMailFrom } from "../src/mail";
import { FakeMailer } from "./fake-mailer";

const DOMAIN = "openping.test";
const KEY = "re_test_secret_key_123";
const FROM = "OpenPing <alerts@openping.test>";
const TENANT = "mailtenant000001";

/** A fetch that records each request and answers from the queue (200 with an id when empty). */
function recordingFetch(answers: (Response | Error)[] = []) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? Response.json({ id: `re_${calls.length}` });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const alert = (over: Partial<HostedEmail> = {}): HostedEmail => ({
  to: ["ops@customer.example"],
  subject: "DOWN: api.customer.example",
  text: "api.customer.example is down.",
  html: "<p>api.customer.example is down.</p>",
  category: "alert",
  ...over,
});

let clock = Date.UTC(2026, 10, 2, 23, 59, 0);

async function tenant(fields: { status?: string; plan?: string; overrides?: string | null; ownerSuspended?: boolean; state?: string } = {}) {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM tenant_email_usage"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO accounts (id, email, created_at, updated_at) VALUES ('acc_mail', 'owner@customer.example', 0, 0)"),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, limit_overrides, owner_suspended_at, created_at, updated_at)
       VALUES (?, 'acc_mail', 'mailer', ?, ?, ?, ?, ?, ?, 0, 0)`,
    ).bind(TENANT, `t-${TENANT}`, fields.status ?? "active", fields.plan ?? "hosted", fields.state ?? "ready", fields.overrides ?? null, fields.ownerSuspended ? 1 : null),
  ]);
}

function capability(mailer: FakeMailer | ResendMailer | null = new FakeMailer()) {
  return new TenantCapability(env.PLATFORM_DB, TENANT, "acc_mail", () => clock, mailer ? { mailer, from: FROM } : null);
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 2, 23, 59, 0);
  await tenant();
});

describe("the Resend mailer", () => {
  it("sends what Resend's API expects, with the platform's key and From", async () => {
    const { fetcher, calls } = recordingFetch();
    const mailer = new ResendMailer(KEY, "OpenPing Hosted <signin@openping.test>", fetcher);
    const sent = await mailer.send({ to: "a@example.com", subject: "Hi", text: "t", html: "<p>t</p>", replyTo: "support@n8builds.dev", category: "signin", tenantId: "abc", idempotencyKey: "k1" });
    expect(sent).toEqual({ ok: true, id: "re_1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("idempotency-key")).toBe("k1");
    expect(calls[0]!.body).toEqual({
      from: "OpenPing Hosted <signin@openping.test>",
      to: ["a@example.com"],
      subject: "Hi",
      text: "t",
      html: "<p>t</p>",
      reply_to: "support@n8builds.dev",
      tags: [
        { name: "category", value: "signin" },
        { name: "tenant", value: "abc" },
      ],
    });
    await mailer.send({ to: "b@example.com", subject: "s", text: "t", html: "", from: FROM });
    expect(calls[1]!.body.from).toBe(FROM);
    expect(calls[1]!.body.tags).toBeUndefined();
    expect(new Headers(calls[1]!.init.headers).has("idempotency-key")).toBe(false);
  });

  it("tells a refused message from a bad moment and from the day's quota", async () => {
    const err = (status: number, name: string) => Response.json({ statusCode: status, name, message: `${name} happened` }, { status });
    const { fetcher } = recordingFetch([
      err(422, "validation_error"),
      err(403, "validation_error"),
      err(429, "rate_limit_exceeded"),
      err(429, "daily_quota_exceeded"),
      err(429, "monthly_quota_exceeded"),
      err(500, "application_error"),
      new Error("connection reset"),
      new Response("not json", { status: 200 }),
    ]);
    const mailer = new ResendMailer(KEY, FROM, fetcher);
    const errors = [];
    for (let i = 0; i < 8; i++) {
      const r = await mailer.send({ to: "a@example.com", subject: "s", text: "t", html: "" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        errors.push(r.error);
        expect(r.message).not.toContain(KEY);
      }
    }
    expect(errors).toEqual(["rejected", "rejected", "unavailable", "quota", "unavailable", "unavailable", "unavailable", "rejected"]);
    expect(classifyResendError(409, "concurrent_idempotent_requests")).toBe("unavailable");
    expect(classifyResendError(409, "invalid_idempotent_request")).toBe("rejected");
  });

  it("is on only with a key and a From on the Hosted domain", () => {
    expect(mailProblem({ HOSTED_DOMAIN: DOMAIN })).toBe("RESEND_API_KEY isn't set");
    expect(mailProblem({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY })).toBe("MAIL_FROM isn't set");
    expect(mailProblem({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY, MAIL_FROM: "OpenPing <x@n8builds.dev>" })).toBe("MAIL_FROM isn't on HOSTED_DOMAIN");
    expect(mailProblem({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY, MAIL_FROM: "x@openping.test", TENANT_MAIL_FROM: "y@evil.example" })).toBe("TENANT_MAIL_FROM isn't on HOSTED_DOMAIN");
    expect(mailerFromEnv({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY, MAIL_FROM: "OpenPing Hosted <signin@openping.test>" })).toBeInstanceOf(ResendMailer);
    expect(tenantMailFrom({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY, MAIL_FROM: "a@openping.test" })).toBe("a@openping.test");
    expect(tenantMailFrom({ HOSTED_DOMAIN: DOMAIN, RESEND_API_KEY: KEY, MAIL_FROM: "a@openping.test", TENANT_MAIL_FROM: FROM })).toBe(FROM);
    expect(tenantMailFromEnv({ HOSTED_DOMAIN: DOMAIN }, new FakeMailer())).toBeNull();
    expect(isOnDomain("a@mail.openping.test", DOMAIN)).toBe(true);
    expect(isOnDomain("a@openping.test.evil.example", DOMAIN)).toBe(false);
    expect(isOnDomain("a@notopenping.test", DOMAIN)).toBe(false);
  });
});

describe("a tenant's email through the platform", () => {
  it("goes out from the platform's address, one message per recipient, tagged with the tenant", async () => {
    const mailer = new FakeMailer();
    const result = await capability(mailer).sendEmail(alert({ to: ["a@x.example", "B@x.example", "a@x.example"], replyTo: "me@customer.example" }));
    expect(result).toEqual({ ok: true, id: "m1" });
    expect(mailer.sent.map((m) => m.to)).toEqual(["a@x.example", "b@x.example"]);
    expect(mailer.sent[0]).toMatchObject({ from: FROM, replyTo: "me@customer.example", category: "alert", tenantId: TENANT, subject: "DOWN: api.customer.example" });
    expect(await emailsToday(env.PLATFORM_DB, TENANT, clock)).toEqual({ sent: 2, failed: 0, refused: 0 });
  });

  it("refuses what isn't one plain email", async () => {
    expect(hostedEmailProblem(alert())).toBeNull();
    const cases: [Partial<HostedEmail>, string][] = [
      [{ to: [] }, "no recipient"],
      [{ to: Array.from({ length: EMAIL_LIMITS.recipients + 1 }, (_, i) => `a${i}@x.example`) }, "more than 10 recipients"],
      [{ to: ["a@x.example, b@y.example"] }, "a recipient isn't an email address"],
      [{ to: ["Name <a@x.example>"] }, "a recipient isn't an email address"],
      [{ replyTo: "nope" }, "the reply-to isn't an email address"],
      [{ subject: "Hi\r\nBcc: everyone@x.example" }, "the subject is empty, too long, or has a line break"],
      [{ subject: "  " }, "the subject is empty, too long, or has a line break"],
      [{ text: "x".repeat(EMAIL_LIMITS.textBytes + 1) }, "the text is missing or too long"],
      [{ category: "Alert!" }, "the category"],
    ];
    const mailer = new FakeMailer();
    for (const [over, problem] of cases) {
      expect(hostedEmailProblem(alert(over)), problem).toBe(problem);
      expect(await capability(mailer).sendEmail(alert(over))).toMatchObject({ ok: false, error: "email_rejected" });
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it("stops at the plan's emails a day, and starts again at the next UTC midnight", async () => {
    await tenant({ overrides: JSON.stringify({ emailsPerDay: 3 }) });
    const mailer = new FakeMailer();
    const cap = capability(mailer);
    for (let i = 0; i < 3; i++) expect((await cap.sendEmail(alert({ category: i ? "report" : "alert" }))).ok).toBe(true);
    const over = await cap.sendEmail(alert());
    expect(over).toEqual({ ok: false, error: "email_quota_exceeded", message: "Your plan sends up to 3 emails a day; the rest go out tomorrow (UTC)." });
    expect(await emailsToday(env.PLATFORM_DB, TENANT, clock)).toEqual({ sent: 3, failed: 0, refused: 1 });
    // Two recipients don't fit in one place either.
    clock += 60_000; // 00:00 UTC
    expect(utcDay(clock)).toBe("2026-11-03");
    expect((await cap.sendEmail(alert({ to: ["a@x.example", "b@x.example"] }))).ok).toBe(true);
    expect(await cap.sendEmail(alert({ to: ["c@x.example", "d@x.example"] }))).toMatchObject({ error: "email_quota_exceeded" });
    expect(mailer.sent).toHaveLength(5);
  });

  it("uses the plan's default cap", async () => {
    await tenant({ plan: "trial", status: "trial" });
    await env.PLATFORM_DB.prepare("INSERT INTO tenant_email_usage (tenant_id, day, category, sent) VALUES (?, ?, 'alert', ?)")
      .bind(TENANT, utcDay(clock), PLAN_LIMITS.trial.emailsPerDay - 1)
      .run();
    const cap = capability();
    expect((await cap.sendEmail(alert())).ok).toBe(true);
    expect(await cap.sendEmail(alert())).toMatchObject({ error: "email_quota_exceeded" });
  });

  it("never lets two sends at once pass the last place", async () => {
    await tenant({ overrides: JSON.stringify({ emailsPerDay: 3 }) });
    const cap = capability();
    const results = await Promise.all(Array.from({ length: 8 }, () => cap.sendEmail(alert())));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.error === "email_quota_exceeded")).toHaveLength(5);
  });

  it("gives back the place of an email the provider didn't take, and says why", async () => {
    await tenant({ overrides: JSON.stringify({ emailsPerDay: 1 }) });
    const mailer = new FakeMailer();
    const cap = capability(mailer);
    mailer.failNext = ["unavailable", "rejected", "quota"];
    expect(await cap.sendEmail(alert())).toMatchObject({ ok: false, error: "email_unavailable" });
    expect(await cap.sendEmail(alert())).toMatchObject({ ok: false, error: "email_rejected" });
    // Resend's own day is spent: the tenant waits for the next UTC day, like for its own cap.
    expect(await cap.sendEmail(alert())).toMatchObject({ ok: false, error: "email_quota_exceeded" });
    expect(await emailsToday(env.PLATFORM_DB, TENANT, clock)).toEqual({ sent: 0, failed: 3, refused: 0 });
    expect((await cap.sendEmail(alert())).ok).toBe(true);
  });

  it("sends nothing for a paused or departing OpenPing, or while mail is off", async () => {
    await tenant({ status: "suspended" });
    expect(await capability().sendEmail(alert())).toMatchObject({ error: "email_unavailable", message: "This OpenPing is paused, so it sends no email." });
    await tenant({ ownerSuspended: true });
    expect(await capability().sendEmail(alert())).toMatchObject({ error: "email_unavailable" });
    await tenant({ state: "deleting" });
    expect(await capability().sendEmail(alert())).toMatchObject({ error: "email_unavailable" });
    await tenant();
    expect(await capability(null).sendEmail(alert())).toMatchObject({ error: "email_unavailable", message: "Email isn't set up on OpenPing Hosted yet." });
  });

  it("never hands the tenant the key, even when the provider's answer would", async () => {
    const { fetcher } = recordingFetch([Response.json({ name: "validation_error", message: `API key ${KEY} is invalid` }, { status: 401 })]);
    const result = await capability(new ResendMailer(KEY, FROM, fetcher)).sendEmail(alert());
    expect(result).toEqual({ ok: false, error: "email_rejected", message: "The mail provider refused this email." });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("forgets days older than five weeks", async () => {
    await env.PLATFORM_DB.prepare("INSERT INTO tenant_email_usage (tenant_id, day, category, sent) VALUES (?, '2026-09-01', 'alert', 4), (?, ?, 'alert', 1)")
      .bind(TENANT, TENANT, utcDay(clock))
      .run();
    await emailUsageCleanup(env.PLATFORM_DB, clock).run();
    const left = await env.PLATFORM_DB.prepare("SELECT day FROM tenant_email_usage").all<{ day: string }>();
    expect(left.results.map((r) => r.day)).toEqual([utcDay(clock)]);
  });
});
