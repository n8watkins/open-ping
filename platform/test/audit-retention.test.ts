import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_DELETE_BATCH, AUDIT_KEEP_DAYS, EXPIRED_EVENTS_SQL, KEPT_ACTIONS, ORPHANED_KEPT_EVENTS_SQL, auditCleanup } from "../src/audit-retention";

const DAY = 86_400_000;
// 03:07 UTC, when the daily pass runs too.
const NOW = Date.UTC(2028, 9, 28, 3, 7);
const OLD = NOW - (AUDIT_KEEP_DAYS + 1) * DAY;
const RECENT = NOW - (AUDIT_KEEP_DAYS - 1) * DAY;

async function event(at: number, action: string, accountId: string | null = "acc_live"): Promise<void> {
  await env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, actor, action) VALUES (?, ?, 'customer', ?)").bind(at, accountId, action).run();
}

async function actions(): Promise<string[]> {
  const rows = await env.PLATFORM_DB.prepare("SELECT action || '@' || COALESCE(account_id, '-') || '@' || (at < ?) AS k FROM audit_events ORDER BY k")
    .bind(NOW - AUDIT_KEEP_DAYS * DAY)
    .all<{ k: string }>();
  return rows.results.map((r) => r.k);
}

async function run(now = NOW): Promise<void> {
  await env.PLATFORM_DB.batch(auditCleanup(env.PLATFORM_DB, now));
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.PLATFORM_DB.batch([env.PLATFORM_DB.prepare("DELETE FROM audit_events"), env.PLATFORM_DB.prepare("DELETE FROM accounts")]);
  await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_live', 'live@example.com', 0, 0)").run();
});

describe("audit log retention", () => {
  it("deletes everything older than two years except the security record of an account that still exists", async () => {
    await event(OLD, "account.signed_in");
    await event(OLD, "handoff.issued");
    await event(OLD, "billing.changed", null);
    await event(RECENT, "account.signed_in");
    for (const action of KEPT_ACTIONS) await event(OLD, action);
    await event(OLD, "support.handoff_issued", "acc_gone");
    await event(OLD, "account.created", null);
    await event(RECENT, "support.handoff_issued", "acc_gone");
    await run();
    expect(await actions()).toEqual(
      [
        "account.signed_in@acc_live@0",
        ...KEPT_ACTIONS.map((a) => `${a}@acc_live@1`),
        // A gone account's recent events wait out their two years like any other.
        "support.handoff_issued@acc_gone@0",
      ].sort(),
    );
  });

  it("drops the kept rows of accounts gone only in the daily pass", async () => {
    await event(OLD, "support.handoff_issued", "acc_gone");
    await event(OLD, "account.signed_in");
    await run(NOW + 3_600_000); // 04:07: the hourly delete only
    expect(await actions()).toEqual(["support.handoff_issued@acc_gone@1"]);
    await run();
    expect(await actions()).toEqual([]);
  });

  it("deletes at most a batch per statement, and catches up on the next runs", async () => {
    const insert = env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, actor, action) VALUES (?, 'acc_live', 'system', 'account.signed_in')");
    await env.PLATFORM_DB.batch(Array.from({ length: AUDIT_DELETE_BATCH + 5 }, (_, i) => insert.bind(OLD - i)));
    await run();
    expect((await actions()).length).toBe(5);
    await run();
    expect(await actions()).toEqual([]);
  });

  it("reads by time over the partial indexes, never the whole table", async () => {
    for (const [sql, index] of [
      [EXPIRED_EVENTS_SQL, "idx_audit_events_expiring"],
      [ORPHANED_KEPT_EVENTS_SQL, "idx_audit_events_kept"],
    ] as const) {
      const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(OLD).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join(" | ");
      expect(details).toContain(`USING INDEX ${index} (at<?)`);
      expect(details).not.toMatch(/SCAN (e|audit_events)(?! USING)/);
    }
  });
});
