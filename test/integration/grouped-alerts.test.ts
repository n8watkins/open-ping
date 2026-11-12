import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { enqueue } from "../../src/worker/db/outbox";
import { ALERT_CAP, processOutbox } from "../../src/worker/notifications/dispatcher";

/**
 * Grouped alerts and the per-channel alert cap (notifications/dispatcher.ts),
 * against real D1 and a webhook channel. On 2026-11-11 a firewall rule made
 * every HTTP monitor fail at once and each one's down alert, then its
 * recovery, went out on its own: about 30 emails in minutes.
 */

const ORIGIN = "https://openping.test";
const HOOK = "https://hooks.example.com/openping";
let channelId = "";

async function createWebhook(): Promise<string> {
  const res = await exports.default.fetch(`${ORIGIN}/api/channels`, {
    method: "POST",
    headers: { authorization: "Bearer integration-api-token", "content-type": "application/json" },
    body: JSON.stringify({ type: "webhook", name: "Grouping hook", config: { url: HOOK } }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ channel: { id: string } }>()).channel.id;
}

/** Queue one alert per monitor on the webhook channel, each `spacingMs` after the last. */
async function queue(event: "down" | "recovered", monitors: string[], opts: { spacingMs?: number; start?: number } = {}) {
  const start = opts.start ?? Date.now();
  await enqueue(
    env,
    monitors.map((m) => ({
      eventKey: `${event}:inc_${m}:${channelId}`,
      monitorId: m,
      channelId,
      channelType: "webhook",
      eventType: event,
      payload: {
        event,
        monitorId: m,
        monitorName: `Site ${m}`,
        state: event === "down" ? "down" : "up",
        title: event === "down" ? `🔴 Site ${m} is down` : `🟢 Site ${m} has recovered`,
        body: event === "down" ? `Site ${m} is down (HTTP 403).` : `Site ${m} is back up after 24 min of downtime.`,
        url: `${ORIGIN}/monitors/${m}`,
        statusCode: event === "down" ? 403 : null,
        error: null,
        detectedAt: start,
        durationSeconds: event === "down" ? null : 1440,
        incidentId: `inc_${m}`,
      },
    })),
  );
  // Spread their queue times the way separate runs would have.
  await env.DB.batch(
    monitors.map((m, i) =>
      env.DB.prepare("UPDATE notification_outbox SET created_at = ? WHERE event_key = ?").bind(
        start + i * (opts.spacingMs ?? 0),
        `${event}:inc_${m}:${channelId}`,
      ),
    ),
  );
}

/** Record every webhook delivery's JSON body. */
function hook() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(HOOK);
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  return bodies;
}

async function statuses(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status",
  ).all<{ status: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.status, r.n]));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  channelId = await createWebhook();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM notification_outbox").run();
});

afterEach(() => vi.restoreAllMocks());

describe("grouped alerts", () => {
  it("sends one message for several monitors down at once, and one for their recovery", async () => {
    const bodies = hook();
    const sites = ["a", "b", "c", "d", "e"];
    await queue("down", sites, { spacingMs: 10_000 });

    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 5, sent: 1, failed: 0 });
    expect(bodies).toHaveLength(1);
    const down = bodies[0]!;
    expect(down.event).toBe("down");
    expect(down.title).toBe("🔴 5 sites down at once");
    expect(down.body).toContain("5 sites down at once: likely a shared cause (network, DNS, firewall).");
    for (const s of sites) expect(down.body).toContain(`- Site ${s} (HTTP 403)`);
    expect(down.url).toBe(`${ORIGIN}/monitors`);
    expect(down.group).toMatchObject({ count: 5 });
    expect((down.group as { monitors: Array<{ incidentId: string }> }).monitors.map((m) => m.incidentId)).toEqual(
      sites.map((s) => `inc_${s}`),
    );

    // Every row it carried is sent, under one batch id.
    const rows = await env.DB.prepare("SELECT status, batch_id FROM notification_outbox").all<{
      status: string;
      batch_id: string | null;
    }>();
    expect(new Set(rows.results.map((r) => r.status))).toEqual(new Set(["sent"]));
    expect(new Set(rows.results.map((r) => r.batch_id)).size).toBe(1);
    expect(rows.results[0]!.batch_id).toMatch(/^grp_/);

    // Recoveries group the same way.
    await queue("recovered", sites);
    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 5, sent: 1, failed: 0 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.event).toBe("recovered");
    expect(bodies[1]!.title).toBe("🟢 5 sites recovered");
    expect(bodies[1]!.body).toContain("- Site a (after 24 min)");
  });

  it("keeps alerts for one or two monitors as they were, one per monitor", async () => {
    const bodies = hook();
    await queue("down", ["x", "y"]);
    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 2, sent: 2, failed: 0 });
    expect(bodies.map((b) => b.title)).toEqual(["🔴 Site x is down", "🔴 Site y is down"]);
    expect(bodies.every((b) => b.group === undefined)).toBe(true);
  });

  it("does not group alerts queued further apart than the window", async () => {
    const bodies = hook();
    await queue("down", ["p", "q", "r"], { spacingMs: 3 * 60_000, start: Date.now() - 10 * 60_000 });
    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 3, sent: 3, failed: 0 });
    expect(bodies.every((b) => b.group === undefined)).toBe(true);
  });

  it("retries a failed grouped alert as one message", async () => {
    const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status: 500 }));
    await queue("down", ["f1", "f2", "f3"]);
    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 3, sent: 0, failed: 1 });
    const rows = await env.DB.prepare("SELECT status, attempts, next_attempt_at FROM notification_outbox").all<{
      status: string;
      attempts: number;
      next_attempt_at: number;
    }>();
    expect(rows.results.every((r) => r.status === "failed" && r.attempts === 1)).toBe(true);
    expect(new Set(rows.results.map((r) => r.next_attempt_at)).size).toBe(1);

    fetches.mockImplementation(async () => new Response(null, { status: 204 }));
    expect(await processOutbox(env, rows.results[0]!.next_attempt_at)).toEqual({ processed: 3, sent: 1, failed: 0 });
    expect(fetches).toHaveBeenCalledTimes(2);
  });
});

describe("the alert cap", () => {
  it(`sends at most ${ALERT_CAP} alerts per channel in 10 minutes and holds back the rest`, async () => {
    const bodies = hook();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Spaced past the grouping window, so none of them group.
    const sites = Array.from({ length: ALERT_CAP + 3 }, (_, i) => `s${i}`);
    await queue("down", sites, { spacingMs: 3 * 60_000, start: Date.now() - 40 * 60_000 });

    const r = await processOutbox(env, Date.now() + 60_000);
    expect(r).toEqual({ processed: ALERT_CAP + 3, sent: ALERT_CAP, failed: 0 });
    expect(bodies).toHaveLength(ALERT_CAP);
    expect(await statuses()).toEqual({ sent: ALERT_CAP, suppressed: 3 });
    const held = await env.DB.prepare("SELECT last_error FROM notification_outbox WHERE status = 'suppressed'").first<{
      last_error: string;
    }>();
    expect(held!.last_error).toMatch(/^alert_cap: over 10 alerts in 10 min/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("alert cap"), expect.any(Array));

    // A later pass still sees the alerts already sent.
    await queue("recovered", ["s0"]);
    expect(await processOutbox(env, Date.now() + 60_000)).toEqual({ processed: 1, sent: 0, failed: 0 });
    expect(bodies).toHaveLength(ALERT_CAP);
  });

  it("counts a grouped alert once", async () => {
    const bodies = hook();
    await queue("down", ["g1", "g2", "g3", "g4"]);
    expect((await processOutbox(env, Date.now() + 60_000)).sent).toBe(1);
    // Nine more, spaced so they don't group, fit under the cap with the group.
    const more = Array.from({ length: ALERT_CAP - 1 }, (_, i) => `m${i}`);
    await queue("recovered", more, { spacingMs: 3 * 60_000, start: Date.now() - 30 * 60_000 });
    expect((await processOutbox(env, Date.now() + 60_000)).sent).toBe(ALERT_CAP - 1);
    expect(bodies).toHaveLength(ALERT_CAP);
  });
});
