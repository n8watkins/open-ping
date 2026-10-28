import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { compactionStatements, resolveRetention } from "../../src/worker/history/rollups";

/**
 * The retention pass clears finished notification deliveries (sent or dead)
 * a month after they finished, so the outbox doesn't grow forever and old
 * failures stop showing in Diagnostics. Pending and failed (still retrying)
 * rows are never touched.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1);

async function seed(id: string, status: string, finishedDaysAgo: number) {
  const at = NOW - finishedDaysAgo * DAY_MS;
  await env.DB.prepare(
    `INSERT INTO notification_outbox
       (id, event_key, channel_type, event_type, payload, status, created_at, updated_at)
     VALUES (?, ?, 'email', 'down', '{}', ?, ?, ?)`,
  )
    .bind(id, `key:${id}`, status, at, at)
    .run();
}

async function remaining(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT id FROM notification_outbox ORDER BY id").all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

async function compact() {
  await env.DB.batch(compactionStatements(env, NOW, resolveRetention(null)).map((s) => s.stmt));
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM notification_outbox").run();
});

describe("outbox retention", () => {
  it("clears sent and dead deliveries a month after they finished", async () => {
    await seed("dead-old", "dead", 31);
    await seed("sent-old", "sent", 31);
    await seed("dead-new", "dead", 29);
    await seed("sent-new", "sent", 1);
    await compact();
    expect(await remaining()).toEqual(["dead-new", "sent-new"]);
  });

  it("never clears deliveries that are still waiting or retrying", async () => {
    await seed("pending-old", "pending", 90);
    await seed("failed-old", "failed", 90);
    await compact();
    expect(await remaining()).toEqual(["failed-old", "pending-old"]);
  });
});
