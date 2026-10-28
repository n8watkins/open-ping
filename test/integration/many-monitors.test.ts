import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";
import { updatesForIncidents } from "../../src/worker/db/incident-updates";

/**
 * A status page with more monitors (and incidents) than D1 binds parameters in
 * one statement (100). The page, its feeds and the incident updates each list
 * their ids in one query, so the list must not take one parameter per id.
 */

const ORIGIN = "https://openping.test";
const MONITORS = 150;
const HOUR = 3_600_000;

function anon(path: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`);
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer integration-api-token");
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

const incidentIds: string[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < MONITORS; i++) {
    const monitorId = `mon_many_${i}`;
    const incidentId = `inc_many_${i}`;
    incidentIds.push(incidentId);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO monitors (id, type, name, config, schedule, public, sort_order, created_at, updated_at)
         VALUES (?, 'http', ?, ?, '{"mode":"always"}', ?, ?, ?, ?)`,
      ).bind(
        monitorId,
        `Many ${i}`,
        JSON.stringify({ url: `https://many${i}.example.com/` }),
        JSON.stringify({ visible: true, name: `Service ${i}`, showUptime: true }),
        i,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO incidents (id, monitor_id, status, started_at, resolved_at, duration_seconds,
           public_message, public, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 600, ?, 1, ?, ?)`,
      ).bind(
        incidentId,
        monitorId,
        // A few still open, so the page has active incidents as well as recent ones.
        i % 50 === 0 ? "open" : "resolved",
        now - (i + 2) * HOUR,
        i % 50 === 0 ? null : now - (i + 1) * HOUR,
        `Incident on service ${i}`,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO incident_updates (id, incident_id, status, message, posted_at, created_at, updated_at)
         VALUES (?, ?, 'identified', ?, ?, ?, ?)`,
      ).bind(`upd_many_${i}`, incidentId, `Update on service ${i}`, now - (i + 1) * HOUR, now, now),
    );
  }
  await env.DB.batch(stmts);
  const pages = await api("/api/status-pages").then((r) => r.json<{ statusPages: { id: string; isDefault: boolean }[] }>());
  const pageId = pages.statusPages.find((p) => p.isDefault)!.id;
  const enabled = await api(`/api/status-pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  expect(enabled.status).toBe(200);
});

describe(`a status page with ${MONITORS} monitors`, () => {
  it("serves the page with its active and recent incidents", async () => {
    const res = await anon("/api/public/status");
    expect(res.status).toBe(200);
    const body = await res.json<{
      groups: { services: unknown[] }[];
      activeIncidents: { updates: unknown[] }[];
      recentIncidents: { updates: unknown[] }[];
    }>();
    expect(body.groups.flatMap((g) => g.services)).toHaveLength(MONITORS);
    expect(body.activeIncidents).toHaveLength(MONITORS / 50);
    expect(body.recentIncidents.length).toBeGreaterThan(0);
    // Each incident comes with its update.
    for (const i of [...body.activeIncidents, ...body.recentIncidents]) expect(i.updates).toHaveLength(1);
  });

  it("serves the RSS and Atom feeds", async () => {
    const rss = await anon("/status/feed.rss");
    expect(rss.status).toBe(200);
    expect(await rss.text()).toContain("Update on service 1");
    const atom = await anon("/status/feed.atom");
    expect(atom.status).toBe(200);
  });

  it("loads the updates of every incident in one query", async () => {
    const updates = await updatesForIncidents(env, incidentIds);
    expect(updates.size).toBe(MONITORS);
    for (const id of incidentIds) expect(updates.get(id)).toHaveLength(1);
  });
});
