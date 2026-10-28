import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import { monthBounds, previousMonth } from "../../src/worker/reports/monthly";

/**
 * Status page communication against workerd and the real D1 migrations:
 * incident updates (REST and MCP), the public page and its RSS/Atom feeds
 * (only public incidents, only their updates), never-checked services, and the
 * monthly report computed from seeded rollups.
 */

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const TZ = "America/Los_Angeles";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PUBLIC_UPDATE = "Identified a bad deploy & rolling back <now>";
const PRIVATE_UPDATE = "Private incident update that must never be public";

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

function anon(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, init);
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{
    result: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  }>();
  return body.result;
}

async function createMonitor(name: string, publicName: string): Promise<string> {
  const res = await api("/api/monitors", {
    method: "POST",
    body: JSON.stringify({
      type: "http",
      name,
      config: { url: `https://${name.toLowerCase().replace(/\W/g, "")}.example.com/health` },
      public: { visible: true, name: publicName, showUptime: true },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ monitor: { id: string } }>()).monitor.id;
}

async function insertIncident(id: string, monitorId: string, opts: { public: boolean; startedAt: number; resolvedAt: number }) {
  await env.DB.prepare(
    `INSERT INTO incidents (id, monitor_id, status, title, started_at, resolved_at, duration_seconds,
       error, private_notes, public_message, public, created_at, updated_at)
     VALUES (?, ?, 'resolved', ?, ?, ?, ?, 'internal-error-detail', 'internal private note', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      monitorId,
      `${id} internal title`,
      opts.startedAt,
      opts.resolvedAt,
      Math.round((opts.resolvedAt - opts.startedAt) / 1000),
      opts.public ? "Checkout errors for some users" : "secret summary",
      opts.public ? 1 : 0,
      opts.startedAt,
      opts.startedAt,
    )
    .run();
}

let monA = "";
let monB = "";
let defaultPageId = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('timezone', ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(TZ, Date.now())
    .run();
  monA = await createMonitor("Checkout API", "Checkout");
  monB = await createMonitor("Internal Billing", "Billing");
  const pages = await api("/api/status-pages").then((r) => r.json<{ statusPages: { id: string; isDefault: boolean }[] }>());
  defaultPageId = pages.statusPages.find((p) => p.isDefault)!.id;
  const enabled = await api(`/api/status-pages/${defaultPageId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  expect(enabled.status).toBe(200);
});

describe("never-checked services on the public page", () => {
  it("shows no uptime figure and waits for the first checks instead of claiming operational", async () => {
    const res = await anon("/api/public/status");
    expect(res.status).toBe(200);
    const body = await res.json<{
      overall: string;
      groups: { services: { name: string; state: string; uptime90d: number | null }[] }[];
    }>();
    const services = body.groups.flatMap((g) => g.services);
    expect(services.map((s) => s.name).sort()).toEqual(["Billing", "Checkout"]);
    expect(services.every((s) => s.state === "unknown" && s.uptime90d === null)).toBe(true);
    expect(body.overall).toBe("awaiting_data");

    // One service with a real state: the other, unchecked one doesn't count.
    await env.DB.prepare("UPDATE monitor_state SET state = 'up', state_since = ?, last_checked_at = ? WHERE monitor_id = ?")
      .bind(Date.now(), Date.now(), monA)
      .run();
    const next = await anon("/api/public/status").then((r) => r.json<{ overall: string }>());
    expect(next.overall).toBe("operational");
  });
});

describe("incident updates, the public page and its feeds", () => {
  const now = Date.now();
  const publicInc = "inc_public_feed";
  const privateInc = "inc_private_feed";
  let firstUpdateId = "";

  beforeAll(async () => {
    await insertIncident(publicInc, monA, { public: true, startedAt: now - 3 * HOUR, resolvedAt: now - HOUR });
    await insertIncident(privateInc, monB, { public: false, startedAt: now - 2 * HOUR, resolvedAt: now - HOUR });
    // A page that shows only the checkout monitor.
    const page = await api("/api/status-pages", {
      method: "POST",
      body: JSON.stringify({ name: "Checkout status", slug: "checkout", enabled: true, includeMode: "monitors", monitorIds: [monA] }),
    });
    expect(page.status).toBe(201);
  });

  it("posts, validates, edits and deletes updates over REST", async () => {
    const first = await api(`/api/incidents/${publicInc}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "investigating", message: "Looking into checkout errors" }),
    });
    expect(first.status).toBe(201);
    firstUpdateId = (await first.json<{ update: { id: string } }>()).update.id;
    expect(firstUpdateId).toMatch(/^iup_/);

    const second = await api(`/api/incidents/${publicInc}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "identified", message: `  ${PUBLIC_UPDATE}  ` }),
    });
    expect(second.status).toBe(201);
    expect((await second.json<{ update: { message: string } }>()).update.message).toBe(PUBLIC_UPDATE);

    const priv = await api(`/api/incidents/${privateInc}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "monitoring", message: PRIVATE_UPDATE }),
    });
    expect(priv.status).toBe(201);

    const bad = await api(`/api/incidents/${publicInc}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "fixed", message: " " }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: string }>()).error).toBe("validation");
    const missing = await api("/api/incidents/inc_nope/updates", {
      method: "POST",
      body: JSON.stringify({ status: "identified", message: "x" }),
    });
    expect(missing.status).toBe(404);
    const anonymous = await anon(`/api/incidents/${publicInc}/updates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "identified", message: "x" }),
    });
    expect(anonymous.status).toBe(401);

    // A throwaway update to edit and delete.
    const temp = await api(`/api/incidents/${publicInc}/updates`, {
      method: "POST",
      body: JSON.stringify({ status: "monitoring", message: "temporary" }),
    });
    const tempId = (await temp.json<{ update: { id: string } }>()).update.id;
    const edited = await api(`/api/incidents/${publicInc}/updates/${tempId}`, {
      method: "PATCH",
      body: JSON.stringify({ message: "temporary, edited" }),
    });
    expect(edited.status).toBe(200);
    expect((await edited.json<{ update: { message: string; status: string } }>()).update).toMatchObject({
      message: "temporary, edited",
      status: "monitoring",
    });
    // An update can only be changed through its own incident.
    const wrongIncident = await api(`/api/incidents/${privateInc}/updates/${tempId}`, { method: "DELETE" });
    expect(wrongIncident.status).toBe(404);
    expect((await api(`/api/incidents/${publicInc}/updates/${tempId}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/incidents/${publicInc}/updates/${tempId}`, { method: "DELETE" })).status).toBe(404);

    const detail = await api(`/api/incidents/${publicInc}`).then((r) =>
      r.json<{ updates: { status: string; message: string }[] }>(),
    );
    expect(detail.updates.map((u) => u.status)).toEqual(["identified", "investigating"]);

    const list = await api("/api/incidents?limit=10").then((r) =>
      r.json<{ incidents: { id: string; updates: unknown[] }[] }>(),
    );
    expect(list.incidents.find((i) => i.id === publicInc)?.updates).toHaveLength(2);
    expect(list.incidents.find((i) => i.id === privateInc)?.updates).toHaveLength(1);
  });

  it("posts updates over MCP and lists them with the incidents", async () => {
    const posted = await mcpCall("post_incident_update", {
      id: privateInc,
      status: "resolved",
      message: PRIVATE_UPDATE,
    });
    expect(posted.isError).toBeUndefined();
    expect(posted.content[0]!.text).toContain("not public");

    const missing = await mcpCall("post_incident_update", { id: "inc_missing", status: "resolved", message: "x" });
    expect(missing.isError).toBe(true);

    const listed = await mcpCall("list_incidents", { status: "all", limit: 10 });
    expect(listed.content[0]!.text).toContain(`Identified at `);
    expect(listed.content[0]!.text).toContain(PUBLIC_UPDATE);
    const incidents = (listed.structuredContent as { incidents: { id: string; updates: { postedAt: string }[] }[] }).incidents;
    const pub = incidents.find((i) => i.id === publicInc)!;
    expect(pub.updates).toHaveLength(2);
    // Times are ISO strings in the install timezone, like every MCP result.
    expect(pub.updates[0]!.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*-0[78]:00$/);
  });

  it("shows only the public incident's updates on the public page", async () => {
    const res = await anon("/api/public/status");
    const text = await res.text();
    expect(text).not.toContain(PRIVATE_UPDATE);
    expect(text).not.toContain("internal private note");
    expect(text).not.toContain("internal-error-detail");
    const body = JSON.parse(text) as {
      recentIncidents: { id: string; message: string; updates: { status: string; message: string; at: number }[] }[];
    };
    expect(body.recentIncidents.map((i) => i.id)).toEqual([publicInc]);
    const updates = body.recentIncidents[0]!.updates;
    expect(updates.map((u) => [u.status, u.message])).toEqual([
      ["identified", PUBLIC_UPDATE],
      ["investigating", "Looking into checkout errors"],
    ]);
    expect(updates[0]!.at).toBeGreaterThanOrEqual(updates[1]!.at);
    expect(Object.keys(updates[0]!).sort()).toEqual(["at", "id", "message", "status"]);
  });

  it("serves RSS and Atom for the default page with the right headers and only public incidents", async () => {
    const rss = await anon("/status/feed.rss");
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(rss.headers.get("cache-control")).toBe("public, max-age=60");
    expect(rss.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rss.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const etag = rss.headers.get("etag");
    expect(etag).toBeTruthy();
    const xml = await rss.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<title>Checkout incident (Identified)</title>");
    expect(xml).toContain(`<link>${ORIGIN}/status#incident-${publicInc}</link>`);
    expect(xml).toContain(`<atom:link href="${ORIGIN}/status/feed.rss" rel="self"`);
    // The update's text, HTML-escaped and then XML-escaped.
    expect(xml).toContain("Identified a bad deploy &amp;amp; rolling back &amp;lt;now&amp;gt;");
    expect(xml).not.toContain(PRIVATE_UPDATE);
    expect(xml).not.toContain("Billing");
    expect(xml).not.toContain("internal");

    const cached = await anon("/status/feed.rss", { headers: { "if-none-match": etag! } });
    expect(cached.status).toBe(304);

    const atom = await anon("/status/feed.atom");
    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    const atomXml = await atom.text();
    expect(atomXml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atomXml).toContain(`<id>${ORIGIN}/status#incident-${publicInc}</id>`);
    expect(atomXml).not.toContain(PRIVATE_UPDATE);
  });

  it("serves per-page feeds by slug and 404s an unknown or disabled page", async () => {
    const rss = await anon("/status/checkout/feed.rss");
    expect(rss.status).toBe(200);
    const xml = await rss.text();
    expect(xml).toContain("<title>Checkout status</title>");
    expect(xml).toContain(`${ORIGIN}/status/checkout#incident-${publicInc}`);
    expect((await anon("/status/checkout/feed.atom")).status).toBe(200);

    const unknown = await anon("/status/nope/feed.rss");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain("<!doctype");

    await api(`/api/status-pages/${defaultPageId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect((await anon("/status/feed.atom")).status).toBe(404);
    await api(`/api/status-pages/${defaultPageId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect((await anon("/status/feed.atom")).status).toBe(200);
  });

  it("removes an incident's updates with the incident", async () => {
    await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(privateInc).run();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM incident_updates WHERE incident_id = ?")
      .bind(privateInc)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("monthly uptime report from seeded rollups", () => {
  const now = Date.now();
  const month = previousMonth(now, TZ);
  const { start, end } = monthBounds(month, TZ);
  let reportMon = "";
  let silentMon = "";
  // Rollups for every UTC hour and day the month touches, uniform except for a
  // two-hour outage and one whole UTC day with no rows (off-hours), so the
  // answer is the same whichever tier the report reads each stretch from.
  const firstDay = Math.floor(start / DAY) * DAY;
  const lastDay = Math.ceil(end / DAY) * DAY;
  const offDay = firstDay + 10 * DAY;
  const outageHour = firstDay + 5 * DAY + 10 * HOUR;
  const isOutage = (h: number) => h === outageHour || h === outageHour + HOUR;

  beforeAll(async () => {
    reportMon = await createMonitor("Report API", "Report API");
    silentMon = await createMonitor("Never Checked", "Never Checked");
    await env.DB.prepare("UPDATE monitors SET created_at = ? WHERE id IN (?, ?)").bind(start - 30 * DAY, reportMon, silentMon).run();

    const stmts: D1PreparedStatement[] = [];
    const insert = (period: string, bucket: number, ok: number, fail: number) =>
      env.DB.prepare(
        `INSERT INTO summaries (id, monitor_id, period, bucket_start, checks, ok_checks, fail_checks,
           sum_latency_ms, monitored_seconds, down_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`${reportMon}:${period}:${bucket}`, reportMon, period, bucket, ok + fail, ok, fail, ok * 100, (ok + fail) * 720, fail * 720);
    for (let day = firstDay; day < lastDay; day += DAY) {
      if (day === offDay) continue;
      let dayOk = 0;
      let dayFail = 0;
      for (let h = day; h < day + DAY; h += HOUR) {
        const fail = isOutage(h) ? 5 : 0;
        stmts.push(insert("hour", h, 5 - fail, fail));
        dayOk += 5 - fail;
        dayFail += fail;
      }
      stmts.push(insert("day", day, dayOk, dayFail));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

    await insertIncident("inc_report_in", reportMon, { public: false, startedAt: outageHour, resolvedAt: outageHour + 2 * HOUR });
    await insertIncident("inc_report_before", reportMon, { public: false, startedAt: start - DAY, resolvedAt: start - DAY + HOUR });
  });

  const monthHours = (end - start) / HOUR;
  const checkedHours = monthHours - 24;
  const checks = checkedHours * 5;
  const expectedUptime = Math.round(((checks - 10) / checks) * 100_000) / 1000;

  it("reports uptime, downtime, monitored time, incidents and response time per monitor", async () => {
    const res = await api(`/api/reports/monthly?month=${month}`);
    expect(res.status).toBe(200);
    const { report } = await res.json<{
      report: {
        month: string;
        timezone: string;
        partial: boolean;
        monitors: { id: string; uptimePct: number | null; checks: number; downtimeMinutes: number; monitoredMinutes: number; incidents: number; avgResponseMs: number | null }[];
      };
    }>();
    expect(report).toMatchObject({ month, timezone: TZ, partial: false });
    const row = report.monitors.find((m) => m.id === reportMon)!;
    expect(row).toEqual(
      expect.objectContaining({
        checks,
        uptimePct: expectedUptime,
        downtimeMinutes: 120,
        // The off-hours day is neither up nor down: it isn't monitored time.
        monitoredMinutes: checkedHours * 60,
        incidents: 1,
        avgResponseMs: 100,
      }),
    );
    const silent = report.monitors.find((m) => m.id === silentMon)!;
    expect(silent).toMatchObject({ uptimePct: null, checks: 0, downtimeMinutes: 0, avgResponseMs: null });
  });

  it("defaults to last month and downloads as CSV", async () => {
    const res = await api("/api/reports/monthly?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="openping-uptime-${month}.csv"`);
    const csv = await res.text();
    const line = csv.split("\r\n").find((l) => l.includes(reportMon))!;
    expect(line).toBe(`${month},${TZ},${reportMon},Report API,http,${expectedUptime},${checks},10,120,${checkedHours * 60},1,100`);
    expect(csv).toContain(",All monitors,");
  });

  it("rejects a bad month, a future month and a bad format, and requires sign-in", async () => {
    expect((await api("/api/reports/monthly?month=2026-13")).status).toBe(400);
    expect((await api("/api/reports/monthly?month=2999-01")).status).toBe(400);
    expect((await api("/api/reports/monthly?format=xml")).status).toBe(400);
    expect((await anon("/api/reports/monthly")).status).toBe(401);
  });

  it("is available over MCP", async () => {
    const result = await mcpCall("get_monthly_report", { month });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(`Uptime report for ${month} (${TZ})`);
    expect(result.content[0]!.text).toContain("Report API");
    const report = (result.structuredContent as { report: { from: string; monitors: unknown[] } }).report;
    expect(report.from).toMatch(/^\d{4}-\d{2}-01T00:00:00-0[78]:00$/);
  });
});
