import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import {
  PLAN_LIMITS,
  type PlanLimitBody,
  type PlanLimits,
  type TenantProps,
  type UsageCounts,
} from "../../src/shared/hosted-contract";

/**
 * Plan limits in hosted mode (docs/hosted/CONTRACT.md, section 5), through the
 * real Worker and D1: every create path (the REST API the dashboard and the
 * CLI use, MCP, a backup import) refuses what is over the plan with 402 and
 * the plan-limit body, a plain install has no limits at all, and every create
 * or delete reports the counts to the platform.
 */

const ORIGIN = "https://openping.test";
const TENANT = "abcdefgh12345678";
const UPGRADE = "https://app.hosted.test/billing/upgrade";

let usageReports: UsageCounts[] = [];
let limits: PlanLimits = PLAN_LIMITS.trial;

const ASSETS = { fetch: async () => new Response("shell") } as unknown as Fetcher;
const plainEnv = (): Env => ({ ...env, ASSETS }) as Env;
const hostedEnv = (): Env => ({ ...env, ASSETS, HOSTED_MODE: "1", TENANT_ID: TENANT }) as Env;

function props(): TenantProps {
  return {
    contract: 1,
    invocation: "public",
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "trial",
      plan: "trial",
      limits,
      trialEndsAt: Date.now() + 86_400_000,
      urls: {
        account: "https://app.hosted.test/account",
        billing: "https://app.hosted.test/billing",
        upgrade: UPGRADE,
        signIn: "https://app.hosted.test/sign-in",
        signOut: "https://app.hosted.test/sign-out",
      },
    },
    platform: {
      sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
      reportUsage: async (counts) => {
        usageReports.push(counts);
      },
      audit: async () => {},
    },
  };
}

/** Collects the waitUntil promises, so a test can wait for the usage report. */
let pending: Promise<unknown>[] = [];

function contextWith(p: unknown): ExecutionContext {
  const base = createExecutionContext();
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      base.waitUntil(promise);
    },
    passThroughOnException: () => base.passThroughOnException(),
    props: p,
  } as unknown as ExecutionContext;
}

async function call(
  path: string,
  init: { method?: string; json?: unknown; hosted?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
  const hosted = init.hosted ?? true;
  const headers = new Headers({ authorization: "Bearer integration-api-token", ...init.headers });
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    }),
    hosted ? hostedEnv() : plainEnv(),
    // Props even for the plain install: it must ignore them.
    contextWith(props()),
  );
  await Promise.allSettled(pending);
  pending = [];
  return res;
}

const heartbeat = (name: string) => ({ type: "heartbeat", name, config: { intervalSeconds: 3600, graceSeconds: 300 } });

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await call("/mcp", {
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  });
  expect(res.status).toBe(200);
  const body = await res.json<{
    result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  }>();
  return body.result;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  usageReports = [];
  pending = [];
  limits = PLAN_LIMITS.trial;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM notification_channels"),
    env.DB.prepare("DELETE FROM status_pages WHERE is_default = 0"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("monitors", () => {
  it("creates up to the plan's monitors, then answers 402 with the plan-limit body", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await call("/api/monitors", { json: heartbeat(`Job ${i}`) });
      expect(res.status, `monitor ${i}`).toBe(201);
    }
    const res = await call("/api/monitors", { json: heartbeat("Job 6") });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: "plan_limit",
      limit: "monitors",
      allowed: 5,
      requested: 6,
      plan: "trial",
      message: "Your plan includes 5 monitors. Remove one or upgrade to add more.",
      upgradeUrl: UPGRADE,
    } satisfies PlanLimitBody);
    expect(await count("monitors")).toBe(5);
  });

  it("checks the body first: an invalid monitor is still a 400, even at the limit", async () => {
    limits = { ...PLAN_LIMITS.trial, monitors: 0 };
    const res = await call("/api/monitors", { json: { type: "heartbeat", name: "" } });
    expect(res.status).toBe(400);
  });

  it("counts paused monitors, and keeps every monitor a downgrade left over the limit", async () => {
    limits = PLAN_LIMITS.hosted;
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await call("/api/monitors", { json: heartbeat(`Kept ${i}`) });
      ids.push((await res.json<{ monitor: { id: string } }>()).monitor.id);
    }
    await call(`/api/monitors/${ids[0]}/pause`, { method: "POST" });

    limits = PLAN_LIMITS.trial; // downgraded: 6 monitors on a 5-monitor plan
    expect((await call("/api/monitors", { json: heartbeat("One more") })).status).toBe(402);
    // Nothing was deleted, and the ones over the limit can still be edited.
    expect(await count("monitors")).toBe(6);
    const edit = await call(`/api/monitors/${ids[5]}`, { method: "PATCH", json: { name: "Renamed" } });
    expect(edit.status).toBe(200);
  });

  it("refuses a polled monitor checked more often than the plan allows, but never a heartbeat", async () => {
    limits = { ...PLAN_LIMITS.trial, minIntervalMinutes: 15 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const http = await call("/api/monitors", { json: { type: "http", name: "Site", config: { url: "https://site.example.com/" } } });
    expect(http.status).toBe(402);
    expect(await http.json()).toMatchObject({ limit: "interval", allowed: 15, requested: 12 });
    // A heartbeat's interval is how often its job pings, not a check.
    const hb = await call("/api/monitors", { json: { type: "heartbeat", name: "Fast job", config: { intervalSeconds: 60, graceSeconds: 0 } } });
    expect(hb.status).toBe(201);
  });

  it("refuses create_monitor over MCP the same way", async () => {
    limits = { ...PLAN_LIMITS.trial, monitors: 1 };
    expect((await mcp("create_monitor", heartbeat("Over MCP"))).isError).toBeFalsy();
    const refused = await mcp("create_monitor", heartbeat("One too many"));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(
      `Your plan includes 1 monitor. Remove one or upgrade to add more. Upgrade: ${UPGRADE}`,
    );
    expect(refused.structuredContent).toMatchObject({ planLimit: { error: "plan_limit", limit: "monitors" } });
    expect(await count("monitors")).toBe(1);
  });

  it("refuses a backup import that would go over, before creating anything", async () => {
    limits = { ...PLAN_LIMITS.trial, monitors: 3 };
    await call("/api/monitors", { json: heartbeat("Existing") });
    const data = {
      version: 1,
      monitors: [heartbeat("Existing"), heartbeat("New A"), heartbeat("New B"), heartbeat("New C")],
      maintenance: [],
      incidents: [],
    };
    // A preview is fine.
    expect((await call("/api/data/import", { json: { data, options: { dryRun: true } } })).status).toBe(200);
    // "Existing" is skipped, so this would make 4 of 3.
    const res = await call("/api/data/import", { json: { data } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ limit: "monitors", allowed: 3, requested: 4 });
    expect(await count("monitors")).toBe(1);

    // Without one of them it fits.
    const fits = await call("/api/data/import", { json: { data: { ...data, monitors: data.monitors.slice(0, 3) } } });
    expect(fits.status).toBe(200);
    expect(await count("monitors")).toBe(3);
  });
});

describe("status pages", () => {
  const page = { name: "Second page", slug: "second" };

  it("counts the default page, so a 1-page plan can't add one", async () => {
    const res = await call("/api/status-pages", { json: page });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: "plan_limit",
      limit: "status_pages",
      allowed: 1,
      requested: 2,
      message: "Your plan includes 1 status page. Remove one or upgrade to add more.",
      upgradeUrl: UPGRADE,
    });
  });

  it("creates up to the plan's pages", async () => {
    limits = PLAN_LIMITS.hosted;
    expect((await call("/api/status-pages", { json: page })).status).toBe(201);
    expect((await call("/api/status-pages", { json: { name: "Third", slug: "third" } })).status).toBe(402);
  });
});

describe("channels", () => {
  it("creates the kinds the plan includes and refuses the others", async () => {
    const email = await call("/api/channels", { json: { type: "email", name: "Me", config: { to: "me@example.com" } } });
    expect(email.status).toBe(201);
    const discord = await call("/api/channels", {
      json: { type: "discord", name: "Ops", config: { url: "https://discord.com/api/webhooks/1/abc" } },
    });
    expect(discord.status).toBe(402);
    expect(await discord.json()).toMatchObject({
      limit: "channel_kind",
      allowed: ["email"],
      requested: "discord",
      message: "Your plan includes email alerts. Upgrade to add discord alerts.",
    });
    expect(await count("notification_channels")).toBe(1);

    limits = PLAN_LIMITS.hosted;
    const allowed = await call("/api/channels", {
      json: { type: "discord", name: "Ops", config: { url: "https://discord.com/api/webhooks/1/abc" } },
    });
    expect(allowed.status).toBe(201);
  });
});

describe("usage reports", () => {
  it("reports the counts after each create and delete, and not after a refusal or a read", async () => {
    const created = await call("/api/monitors", { json: heartbeat("Counted") });
    const { monitor } = await created.json<{ monitor: { id: string } }>();
    expect(usageReports).toEqual([expect.objectContaining({ monitors: 1, channels: 0 })]);
    expect(usageReports[0]!.statusPages).toBe(1);

    await call("/api/monitors");
    await call(`/api/monitors/${monitor.id}/pause`, { method: "POST" });
    limits = { ...PLAN_LIMITS.trial, monitors: 1 };
    await call("/api/monitors", { json: heartbeat("Refused") });
    expect(usageReports).toHaveLength(1);

    await call(`/api/monitors/${monitor.id}`, { method: "DELETE" });
    expect(usageReports).toHaveLength(2);
    expect(usageReports[1]).toMatchObject({ monitors: 0 });

    await mcp("create_monitor", heartbeat("Over MCP"));
    expect(usageReports).toHaveLength(3);
  });
});

describe("a plain install (HOSTED_MODE unset)", () => {
  it("has no plan limits, even when a caller passes props", async () => {
    for (let i = 1; i <= 7; i++) {
      const res = await call("/api/monitors", { json: heartbeat(`Plain ${i}`), hosted: false });
      expect(res.status, `monitor ${i}`).toBe(201);
    }
    expect((await call("/api/status-pages", { json: { name: "Second", slug: "second" }, hosted: false })).status).toBe(201);
    expect((await call("/api/status-pages", { json: { name: "Third", slug: "third" }, hosted: false })).status).toBe(201);
    expect(
      (
        await call("/api/channels", {
          json: { type: "discord", name: "Ops", config: { url: "https://discord.com/api/webhooks/1/abc" } },
          hosted: false,
        })
      ).status,
    ).toBe(201);
    expect(usageReports).toEqual([]);
  });
});
