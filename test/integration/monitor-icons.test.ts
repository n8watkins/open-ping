import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import { listIconRows, refreshMonitorIcon, refreshStaleIcons } from "../../src/worker/lib/favicon";
import { getMonitor } from "../../src/worker/db/monitors";

/**
 * A monitor's site icon, against real D1: fetched by the Worker (never the
 * browser), kept small, served from OpenPing's own origin, refreshed at most
 * weekly and again when the monitor's address moves.
 */

const ORIGIN = "https://openping.test";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 9, 8, 7]);
const now = Date.now();

function api(path: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { authorization: "Bearer integration-api-token" } });
}

function site(host: string, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(`https://${host}/`) && !url.endsWith(".png") && !url.endsWith(".ico")) return new Response('<link rel="icon" href="/i.png">', { headers: { "content-type": "text/html" } });
    if (url === `https://${host}/i.png`) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const monitor = (id: string, type: string, config: object) =>
    env.DB.prepare(
      `INSERT INTO monitors (id, type, name, config, schedule, public, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{"mode":"always"}', '{"visible":false}', 0, ?, ?)`,
    ).bind(id, type, id, JSON.stringify(config), now, now);
  await env.DB.batch([
    monitor("icon-a", "http", { url: "https://a.example.com/status?token=secret" }),
    monitor("icon-b", "http", { url: "https://b.example.com/" }),
    monitor("tcp-c", "tcp", { host: "c.example.com", port: 22 }),
  ]);
});

describe("monitor icons", () => {
  it("fetches once, stores the image, serves it from OpenPing with nosniff, and lists it", async () => {
    const calls: string[] = [];
    const monitor = (await getMonitor(env, "icon-a"))!;
    await refreshMonitorIcon(env, monitor, now, site("a.example.com", calls));
    expect(calls).toEqual(["https://a.example.com/status?token=secret", "https://a.example.com/i.png"]);

    const res = await api("/api/monitors/icon-a/icon");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const overview = (await (await api("/api/overview")).json()) as { monitors: { id: string; iconAt: number | null }[] };
    expect(overview.monitors.find((m) => m.id === "icon-a")?.iconAt).toBe(now);
    expect(overview.monitors.find((m) => m.id === "tcp-c")?.iconAt).toBeNull();
    const detail = (await (await api("/api/monitors/icon-a/detail")).json()) as { iconAt: number | null };
    expect(detail.iconAt).toBe(now);
  });

  it("serves 404 when there is no icon, and never fetches for non-HTTP monitors", async () => {
    expect((await api("/api/monitors/tcp-c/icon")).status).toBe(404);
    const calls: string[] = [];
    await refreshMonitorIcon(env, (await getMonitor(env, "tcp-c"))!, now, site("c.example.com", calls));
    expect(calls).toEqual([]);
  });

  it("does not ask again within a week, even after a miss, but does when the address moves", async () => {
    const calls: string[] = [];
    const b = (await getMonitor(env, "icon-b"))!;
    const none = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    await refreshMonitorIcon(env, b, now, none);
    const afterMiss = calls.length;
    expect(afterMiss).toBeGreaterThan(0);
    expect((await listIconRows(env)).get("icon-b")).toMatchObject({ hasIcon: false, fetchedAt: now });

    // Fresh: nothing is scheduled.
    const scheduled: Promise<unknown>[] = [];
    refreshStaleIcons(env, [b], await listIconRows(env), (p) => scheduled.push(p), now + 1000);
    expect(scheduled).toHaveLength(0);

    // A week on: due again. A moved address: due at once, and the old site's icon is dropped.
    refreshStaleIcons(env, [b], await listIconRows(env), (p) => scheduled.push(p), now + 8 * 86_400_000);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);

    const moved = { ...(await getMonitor(env, "icon-a"))!, config: { ...(await getMonitor(env, "icon-a"))!.config, url: "https://other.example.org/" } };
    refreshStaleIcons(env, [moved], await listIconRows(env), (p) => scheduled.push(p), now + 1000);
    expect(scheduled).toHaveLength(2);
  });
});
