import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import { tlsReader } from "../../src/worker/checks/cert";
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
      upgradeUrl: `${UPGRADE}?need=monitors`,
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
    const site = { type: "http", config: { url: "https://site.example.com/" } };
    const http = await call("/api/monitors", { json: { ...site, name: "Site", intervalSeconds: 60 } });
    expect(http.status).toBe(402);
    expect(await http.json()).toMatchObject({ limit: "interval", allowed: 15, requested: 1 });
    // With no interval, a new monitor gets the plan's shortest when that is over 12 minutes.
    const fits = await call("/api/monitors", { json: { ...site, name: "Site" } });
    expect(fits.status).toBe(201);
    expect(await fits.json()).toMatchObject({ monitor: { intervalSeconds: 900 } });
    // A heartbeat's interval is how often its job pings, not a check.
    const hb = await call("/api/monitors", { json: { type: "heartbeat", name: "Fast job", config: { intervalSeconds: 60, graceSeconds: 0 } } });
    expect(hb.status).toBe(201);
  });

  it("applies the same limits to an SSL certificate monitor", async () => {
    limits = { ...PLAN_LIMITS.trial, minIntervalMinutes: 15 };
    vi.spyOn(tlsReader, "read").mockResolvedValue({
      ok: false,
      kind: "connect_failed",
      message: "proxy request failed, cannot connect to the specified address",
      durationMs: 1,
    });
    const cert = { type: "cert", name: "TLS", config: { host: "shop.example.com" } };
    const fast = await call("/api/monitors", { json: { ...cert, intervalSeconds: 60 } });
    expect(fast.status).toBe(402);
    expect(await fast.json()).toMatchObject({ limit: "interval", allowed: 15, requested: 1 });
    const fits = await call("/api/monitors", { json: cert });
    expect(fits.status).toBe(201);
    expect(await fits.json()).toMatchObject({ monitor: { intervalSeconds: 900 }, firstCheck: { state: "cant_check" } });

    limits = { ...PLAN_LIMITS.trial, monitors: 1 };
    const over = await call("/api/monitors", { json: { ...cert, name: "TLS 2" } });
    expect(over.status).toBe(402);
    expect(await over.json()).toMatchObject({ limit: "monitors" });
  });

  it("refuses create_monitor over MCP the same way", async () => {
    limits = { ...PLAN_LIMITS.trial, monitors: 1 };
    expect((await mcp("create_monitor", heartbeat("Over MCP"))).isError).toBeFalsy();
    const refused = await mcp("create_monitor", heartbeat("One too many"));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(
      `Your plan includes 1 monitor. Remove one or upgrade to add more. Upgrade: ${UPGRADE}?need=monitors`,
    );
    expect(refused.structuredContent).toMatchObject({ planLimit: { error: "plan_limit", limit: "monitors" } });
    expect(await count("monitors")).toBe(1);
  });

  it("restores an import's fast monitors at the plan's shortest interval", async () => {
    limits = { ...PLAN_LIMITS.trial, minIntervalMinutes: 15 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const site = { type: "http", name: "Site", config: { url: "https://site.example.com/" } };
    await env.DB.prepare(
      `INSERT INTO monitors (id, type, name, config, schedule, created_at, updated_at)
       VALUES ('mon_kept', 'http', 'Site', '{"url":"https://site.example.com/"}', '{"mode":"always"}', 0, 0)`,
    ).run();
    const data = { version: 1, monitors: [site, heartbeat("New job")], maintenance: [], incidents: [] };
    // "Site" exists, so it is skipped and its 12-minute checks don't count.
    expect((await call("/api/data/import", { json: { data } })).status).toBe(200);
    expect(await count("monitors")).toBe(2);
    // A new monitor faster than the plan is restored at the plan's shortest, not refused.
    const fast = { ...site, name: "Site 2", intervalSeconds: 60 };
    const all = await call("/api/data/import", { json: { data: { ...data, monitors: [fast] } } });
    expect(all.status).toBe(200);
    const restored = await env.DB.prepare("SELECT interval_seconds FROM monitors WHERE name = 'Site 2'").first();
    expect(restored).toEqual({ interval_seconds: 900 });
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
      upgradeUrl: `${UPGRADE}?need=status_pages`,
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

describe("check intervals", () => {
  const site = (name: string, extra: Record<string, unknown> = {}) => ({
    type: "http",
    name,
    config: { url: "https://site.example.com/" },
    ...extra,
  });
  const intervalOf = async (res: Response) => (await res.json<{ monitor: { intervalSeconds: number } }>()).monitor;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  });

  it("keeps each polled monitor's own interval on the fast checks plan", async () => {
    limits = PLAN_LIMITS.hosted_fast;
    const created = await intervalOf(await call("/api/monitors", { json: site("Fast", { intervalSeconds: 60 }) }));
    expect(created.intervalSeconds).toBe(60);
    const id = (created as unknown as { id: string }).id;

    // The editor's full replace sends no interval: the monitor keeps its own.
    const put = await call(`/api/monitors/${id}`, { method: "PUT", json: site("Fast, renamed") });
    expect(put.status).toBe(200);
    expect((await intervalOf(put)).intervalSeconds).toBe(60);

    const patch = await call(`/api/monitors/${id}`, { method: "PATCH", json: { intervalSeconds: 300 } });
    expect((await intervalOf(patch)).intervalSeconds).toBe(300);

    // Whole minutes only.
    const odd = await call(`/api/monitors/${id}`, { method: "PATCH", json: { intervalSeconds: 90 } });
    expect(odd.status).toBe(400);
  });

  it("defaults a new monitor to 12 minutes, and refuses 1 minute without the add-on", async () => {
    limits = PLAN_LIMITS.hosted;
    const plain = await intervalOf(await call("/api/monitors", { json: site("Default") }));
    expect(plain.intervalSeconds).toBe(720);
    const hourly = await intervalOf(await call("/api/monitors", { json: site("Hourly", { intervalSeconds: 3600 }) }));
    expect(hourly.intervalSeconds).toBe(3600);

    const fast = await call("/api/monitors", { json: site("Too fast", { intervalSeconds: 60 }) });
    expect(fast.status).toBe(402);
    expect(await fast.json()).toMatchObject({
      limit: "interval",
      allowed: 12,
      requested: 1,
      message: "Your plan checks every 12 minutes at the fastest. Add fast checks for 1-minute checks.",
      upgradeUrl: `${UPGRADE}?need=interval`,
    });
  });

  it("lets a downgraded 1-minute monitor be edited, but not made faster again", async () => {
    limits = PLAN_LIMITS.hosted_fast;
    const { id } = (await (await call("/api/monitors", { json: site("Was fast", { intervalSeconds: 60 }) })).json<{
      monitor: { id: string };
    }>()).monitor;
    limits = PLAN_LIMITS.hosted;
    const rename = await call(`/api/monitors/${id}`, { method: "PATCH", json: { name: "Still set to 1 minute" } });
    expect(rename.status).toBe(200);
    expect((await intervalOf(rename)).intervalSeconds).toBe(60);
    const faster = await call(`/api/monitors/${id}`, { method: "PATCH", json: { intervalSeconds: 120 } });
    expect(faster.status).toBe(402);
  });

  it("takes an interval over MCP on Hosted", async () => {
    limits = PLAN_LIMITS.hosted_fast;
    const r = await mcp("create_monitor", site("Over MCP", { intervalSeconds: 120 }));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ monitor: { intervalSeconds: 120 } });
  });

  it("checks every polled monitor every 12 minutes on a plain install, whatever is sent", async () => {
    const res = await call("/api/monitors", { json: site("Plain", { intervalSeconds: 60 }), hosted: false });
    expect(res.status).toBe(201);
    const created = await intervalOf(res);
    expect(created.intervalSeconds).toBe(720);
    // An interval no install accepts is ignored there too, as any field a plain install doesn't use.
    const odd = await call("/api/monitors", { json: site("Plain odd", { intervalSeconds: 90 }), hosted: false });
    expect(odd.status).toBe(201);
    expect((await intervalOf(odd)).intervalSeconds).toBe(720);
    const { id } = created as unknown as { id: string };
    const put = await call(`/api/monitors/${id}`, { method: "PUT", json: site("Plain", { intervalSeconds: 30 }), hosted: false });
    expect(put.status).toBe(200);
    const patch = await call(`/api/monitors/${id}`, { method: "PATCH", json: { intervalSeconds: "soon" }, hosted: false });
    expect(patch.status).toBe(200);
    expect((await intervalOf(patch)).intervalSeconds).toBe(720);
  });

  describe("fast monitors", () => {
    const create = (name: string, intervalSeconds: number) =>
      call("/api/monitors", { json: site(name, { intervalSeconds }) });
    const idOf = async (res: Response) => (await res.json<{ monitor: { id: string } }>()).monitor.id;
    /** Five 1-minute monitors, all the fast checks plan allows. */
    async function fillFast(): Promise<string[]> {
      limits = PLAN_LIMITS.hosted_fast;
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const res = await create(`Fast ${i}`, 60);
        expect(res.status, `fast ${i}`).toBe(201);
        ids.push(await idOf(res));
      }
      return ids;
    }

    it("creates up to the plan's fast monitors, then refuses with the way to fix it", async () => {
      await fillFast();
      const res = await create("Sixth", 300);
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({
        error: "plan_limit",
        limit: "fast_monitors",
        allowed: 5,
        requested: 6,
        plan: "trial",
        message:
          "Your plan includes 5 fast monitors, checked more often than every 12 minutes. Set one to 12 minutes or more, or add more fast monitors.",
        upgradeUrl: `${UPGRADE}?need=fast_monitors`,
      } satisfies PlanLimitBody);
      // 12 minutes and slower, and heartbeats, are never fast.
      expect((await create("Standard", 720)).status).toBe(201);
      expect((await create("Hourly", 3600)).status).toBe(201);
      expect((await call("/api/monitors", { json: { type: "heartbeat", name: "Job", config: { intervalSeconds: 60, graceSeconds: 0 } } })).status).toBe(201);
      // A pack's worth more from the platform: the next one fits.
      limits = { ...PLAN_LIMITS.hosted_fast, fastMonitors: 10 };
      expect((await create("Sixth", 300)).status).toBe(201);
    });

    it("counts paused fast monitors", async () => {
      const [first] = await fillFast();
      await call(`/api/monitors/${first}/pause`, { method: "POST" });
      expect((await create("Sixth", 60)).status).toBe(402);
    });

    it("holds an edit to it only when it makes a monitor fast, leaving the monitor itself out", async () => {
      const ids = await fillFast();
      const slow = await idOf(await create("Slow", 720));
      // PATCH and PUT to a fast interval: refused at the limit.
      const patch = await call(`/api/monitors/${slow}`, { method: "PATCH", json: { intervalSeconds: 60 } });
      expect(patch.status).toBe(402);
      expect(await patch.json()).toMatchObject({ limit: "fast_monitors", allowed: 5, requested: 6 });
      const put = await call(`/api/monitors/${slow}`, { method: "PUT", json: site("Slow", { intervalSeconds: 120 }) });
      expect(put.status).toBe(402);
      // A fast one may change to another fast interval: it doesn't count against itself.
      const faster = await call(`/api/monitors/${ids[0]}`, { method: "PATCH", json: { intervalSeconds: 120 } });
      expect(faster.status).toBe(200);
      // Slowing one frees its place.
      expect((await call(`/api/monitors/${ids[1]}`, { method: "PATCH", json: { intervalSeconds: 720 } })).status).toBe(200);
      expect((await call(`/api/monitors/${slow}`, { method: "PATCH", json: { intervalSeconds: 60 } })).status).toBe(200);
    });

    it("keeps every fast monitor a downgrade left over, editable, but refuses another", async () => {
      const ids = await fillFast();
      limits = { ...PLAN_LIMITS.hosted_fast, fastMonitors: 2 };
      // Nothing is deleted or slowed in the database.
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE interval_seconds = 60").first<{ n: number }>();
      expect(rows!.n).toBe(5);
      expect((await call(`/api/monitors/${ids[4]}`, { method: "PATCH", json: { name: "Renamed" } })).status).toBe(200);
      expect((await call(`/api/monitors/${ids[4]}`, { method: "PATCH", json: { intervalSeconds: 120 } })).status).toBe(402);
      expect((await create("New fast", 60)).status).toBe(402);
    });

    it("refuses update_monitor and create_monitor over MCP the same way", async () => {
      await fillFast();
      const created = await mcp("create_monitor", site("Over MCP", { intervalSeconds: 60 }));
      expect(created.isError).toBe(true);
      expect(created.content[0]!.text).toBe(
        "Your plan includes 5 fast monitors, checked more often than every 12 minutes. Set one to 12 minutes or more, or add more fast monitors. " +
          `Upgrade: ${UPGRADE}?need=fast_monitors`,
      );
      expect(created.structuredContent).toMatchObject({ planLimit: { limit: "fast_monitors" } });
      const slow = await mcp("create_monitor", site("Slow over MCP", { intervalSeconds: 720 }));
      expect(slow.isError).toBeFalsy();
      const { id } = (slow.structuredContent as { monitor: { id: string } }).monitor;
      const updated = await mcp("update_monitor", { id, intervalSeconds: 60 });
      expect(updated.isError).toBe(true);
      expect(updated.structuredContent).toMatchObject({ planLimit: { limit: "fast_monitors", requested: 6 } });
    });

    it("restores an import's fast monitors past the allowance at 12 minutes, in the backup's order", async () => {
      limits = PLAN_LIMITS.hosted_fast;
      await create("Here already", 60);
      await create("Here too", 60);
      const backup = ["A", "B", "C", "D", "E"].map((n) => site(`Backup ${n}`, { intervalSeconds: 60 }));
      const data = { version: 1, monitors: [...backup, site("Backup hourly", { intervalSeconds: 3600 })], maintenance: [], incidents: [] };
      const res = await call("/api/data/import", { json: { data } });
      expect(res.status).toBe(200);
      const rows = await env.DB.prepare("SELECT name, interval_seconds AS s FROM monitors WHERE name LIKE 'Backup %' ORDER BY name").all();
      expect(rows.results).toEqual([
        { name: "Backup A", s: 60 },
        { name: "Backup B", s: 60 },
        { name: "Backup C", s: 60 },
        { name: "Backup D", s: 720 },
        { name: "Backup E", s: 720 },
        { name: "Backup hourly", s: 3600 },
      ]);
    });

    it("reports fast monitors with the usage, after an edit too", async () => {
      limits = PLAN_LIMITS.hosted_fast;
      const id = await idOf(await create("Fast", 60));
      expect(usageReports.at(-1)).toMatchObject({ monitors: 1, fastMonitors: 1 });
      await call(`/api/monitors/${id}`, { method: "PATCH", json: { intervalSeconds: 720 } });
      expect(usageReports.at(-1)).toMatchObject({ monitors: 1, fastMonitors: 0 });
    });

    it("never applies on a plain install", async () => {
      limits = { ...PLAN_LIMITS.hosted_fast, fastMonitors: 0 };
      for (let i = 1; i <= 3; i++) {
        expect((await call("/api/monitors", { json: site(`Plain ${i}`, { intervalSeconds: 60 }), hosted: false })).status).toBe(201);
      }
    });
  });

  it("restores a backup whose interval no install accepts, at the default", async () => {
    limits = PLAN_LIMITS.hosted;
    const data = { version: 1, monitors: [site("Odd backup", { intervalSeconds: 90 })], maintenance: [], incidents: [] };
    for (const hosted of [true, false]) {
      await env.DB.prepare("DELETE FROM monitors").run();
      const res = await call("/api/data/import", { json: { data }, hosted });
      expect(res.status, hosted ? "hosted" : "plain").toBe(200);
      const row = await env.DB.prepare("SELECT interval_seconds FROM monitors WHERE name = 'Odd backup'").first();
      expect(row).toEqual({ interval_seconds: 720 });
    }
  });
});
