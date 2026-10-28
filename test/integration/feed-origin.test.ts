import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../../src/worker/index";

/**
 * Feed links and ids come from the install's configured origin (APP_URL, here
 * https://openping.test), never from the Host the request arrived on: a reader
 * that subscribed through a workers.dev address or a spoofed Host must still
 * get links to the real status page, and an entry's id must not change with
 * the address it was fetched from.
 */

const ORIGIN = "https://openping.test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const headers = { authorization: "Bearer integration-api-token", "content-type": "application/json" };
  const pages = await exports.default
    .fetch(`${ORIGIN}/api/status-pages`, { headers })
    .then((r) => r.json<{ statusPages: { id: string; isDefault: boolean }[] }>());
  const pageId = pages.statusPages.find((p) => p.isDefault)!.id;
  const enabled = await exports.default.fetch(`${ORIGIN}/api/status-pages/${pageId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  expect(enabled.status).toBe(200);
});

describe("feed links", () => {
  for (const format of ["rss", "atom"] as const) {
    it(`point at the configured origin in the ${format} feed, whatever the request's host`, async () => {
      const res = await exports.default.fetch(`https://other-host.workers.dev/status/feed.${format}`);
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain(`${ORIGIN}/status/feed.${format}`);
      expect(xml).not.toContain("other-host.workers.dev");
    });
  }
});
