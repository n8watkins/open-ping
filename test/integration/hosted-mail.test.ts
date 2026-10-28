import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { INTERNAL_HEADER, PLAN_LIMITS, type HostedEmail, type TenantProps } from "../../src/shared/hosted-contract";

/**
 * Mail through the platform (docs/hosted/CONTRACT.md, sections 2 and 4), with
 * the real Worker and D1: in hosted mode an alert, from a scheduled run or a
 * channel test, goes out through `props.platform.sendEmail` and never through
 * Resend, even with a RESEND_API_KEY set; a plain install still uses Resend.
 */

const ORIGIN = "https://openping.test";
const TENANT = "abcdefgh12345678";
const TO = "oncall@customer.test";

let sent: HostedEmail[] = [];
let answer: "ok" | "quota" = "ok";

const ASSETS = { fetch: async () => new Response("shell") } as unknown as Fetcher;
const plainEnv = (): Env => ({ ...env, ASSETS, RESEND_API_KEY: "re_test" }) as Env;
const hostedEnv = (): Env =>
  ({ ...env, ASSETS, HOSTED_MODE: "1", TENANT_ID: TENANT, RESEND_API_KEY: "re_test" }) as Env;

function props(invocation: "public" | "platform" = "public"): TenantProps {
  return {
    contract: 1,
    invocation,
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "active",
      plan: "hosted",
      limits: PLAN_LIMITS.hosted,
      trialEndsAt: null,
      urls: {
        account: "https://app.hosted.test/account",
        billing: "https://app.hosted.test/billing",
        upgrade: "https://app.hosted.test/upgrade",
        signIn: "https://app.hosted.test/sign-in",
        signOut: "https://app.hosted.test/sign-out",
      },
    },
    platform: {
      sendEmail: async (message) => {
        sent.push(message);
        return answer === "ok"
          ? { ok: true, id: `em_${sent.length}` }
          : { ok: false, error: "email_quota_exceeded", message: "The daily email limit is reached." };
      },
      reportUsage: async () => {},
      audit: async () => {},
    },
  };
}

function contextWith(p: unknown): ExecutionContext {
  const base = createExecutionContext();
  return {
    waitUntil: (promise: Promise<unknown>) => base.waitUntil(promise),
    passThroughOnException: () => base.passThroughOnException(),
    props: p,
  } as unknown as ExecutionContext;
}

function call(path: string, init: { json?: unknown; target: Env; props?: TenantProps; headers?: Record<string, string> }) {
  const headers = new Headers({ authorization: "Bearer integration-api-token", ...init.headers });
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.json !== undefined ? "POST" : "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
    init.target,
    contextWith(init.props ?? props()),
  );
}

async function emailChannel(target: Env): Promise<string> {
  const res = await call("/api/channels", { json: { type: "email", name: "On call", config: { to: TO } }, target });
  expect(res.status).toBe(201);
  return (await res.json<{ channel: { id: string } }>()).channel.id;
}

let resend: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  sent = [];
  answer = "ok";
  resend = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  await env.DB.batch([env.DB.prepare("DELETE FROM notification_outbox"), env.DB.prepare("DELETE FROM notification_channels")]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hosted mode", () => {
  it("sends a channel test through the platform, never Resend", async () => {
    const id = await emailChannel(hostedEnv());
    const res = await call(`/api/channels/${id}/test`, { json: {}, target: hostedEnv() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(sent).toEqual([expect.objectContaining({ to: [TO], category: "alert" })]);
    expect(sent[0]!.text.length).toBeGreaterThan(0);
    expect(sent[0]).not.toHaveProperty("from");
    expect(resend).not.toHaveBeenCalled();
  });

  it("delivers a scheduled run's queued alert through the platform", async () => {
    const id = await emailChannel(hostedEnv());
    const now = Date.now();
    const payload = { event: "down", monitorId: "mon_x", monitorName: "API", state: "down", title: "API is down", body: "HTTP 503", detectedAt: now };
    await env.DB.prepare(
      `INSERT INTO notification_outbox (id, event_key, channel_id, channel_type, target, event_type, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('out_1', 'k:1', ?, 'email', ?, 'down', ?, 'pending', 0, ?, ?, ?)`,
    )
      .bind(id, TO, JSON.stringify(payload), now - 1, now, now)
      .run();

    const p = props("platform");
    const res = await call("/__platform/scheduled", {
      json: { runId: "run_mail", scheduledTime: now, cron: "* * * * *" },
      target: hostedEnv(),
      props: p,
      headers: { [INTERNAL_HEADER]: p.callId },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ran" });
    expect(sent).toEqual([expect.objectContaining({ to: [TO], subject: "API is down", category: "alert" })]);
    expect(resend).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT status FROM notification_outbox WHERE id = 'out_1'").first<{ status: string }>();
    expect(row!.status).toBe("sent");
  });

  it("holds an alert over the daily cap until the next UTC day, without spending its attempts", async () => {
    const id = await emailChannel(hostedEnv());
    const evening = Date.UTC(2026, 9, 28, 23, 0, 0);
    const midnight = Date.UTC(2026, 9, 29, 0, 0, 0);
    const payload = { event: "down", monitorId: "mon_x", monitorName: "API", state: "down", title: "API is down", body: "HTTP 503", detectedAt: evening };
    await env.DB.prepare(
      `INSERT INTO notification_outbox (id, event_key, channel_id, channel_type, target, event_type, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('out_cap', 'k:cap', ?, 'email', ?, 'down', ?, 'pending', 0, ?, ?, ?)`,
    )
      .bind(id, TO, JSON.stringify(payload), evening - 1, evening, evening)
      .run();
    const run = async (at: number, runId: string) => {
      vi.spyOn(Date, "now").mockReturnValue(at);
      await env.DB.prepare("DELETE FROM locks").run();
      const p = props("platform");
      const res = await call("/__platform/scheduled", {
        json: { runId, scheduledTime: at, cron: "* * * * *" },
        target: hostedEnv(),
        props: p,
        headers: { [INTERNAL_HEADER]: p.callId },
      });
      expect(res.status).toBe(200);
      return env.DB.prepare("SELECT status, attempts, next_attempt_at FROM notification_outbox WHERE id = 'out_cap'").first<{
        status: string;
        attempts: number;
        next_attempt_at: number;
      }>();
    };

    // 23:00 UTC, over the cap: put off to midnight, no attempt spent.
    answer = "quota";
    expect(await run(evening, "run_cap_1")).toEqual({ status: "failed", attempts: 0, next_attempt_at: midnight });
    expect(sent).toHaveLength(1);

    // Every run until midnight leaves it alone (an hourly retry would have
    // spent all five attempts by morning).
    for (let minute = 1; minute < 60; minute += 12) {
      expect(await run(evening + minute * 60_000, `run_cap_wait_${minute}`)).toMatchObject({ attempts: 0 });
    }
    expect(sent).toHaveLength(1);

    // After midnight the cap starts over and the alert goes out.
    answer = "ok";
    expect(await run(midnight + 60_000, "run_cap_2")).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(2);
    expect(resend).not.toHaveBeenCalled();
  });

  it("answers a channel test over the daily cap with the cap", async () => {
    answer = "quota";
    const id = await emailChannel(hostedEnv());
    const res = await call(`/api/channels/${id}/test`, { json: {}, target: hostedEnv() });
    expect(await res.json()).toMatchObject({ ok: false, error: "email_quota_exceeded" });
    expect(resend).not.toHaveBeenCalled();
  });
});

describe("a plain install (HOSTED_MODE unset)", () => {
  it("still sends through Resend with its own key, even when a caller passes props", async () => {
    const id = await emailChannel(plainEnv());
    const res = await call(`/api/channels/${id}/test`, { json: {}, target: plainEnv() });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(resend).toHaveBeenCalledOnce();
    expect(String(resend.mock.calls[0]![0])).toBe("https://api.resend.com/emails");
    expect(sent).toEqual([]);
  });
});
