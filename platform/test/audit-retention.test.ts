import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_DELETE_BATCH, AUDIT_KEEP_DAYS, EXPIRED_EVENTS_SQL, KEPT_ACTIONS, auditCleanup } from "../src/audit-retention";

const DAY = 86_400_000;
const NOW = Date.UTC(2028, 9, 28, 3, 7);
const OLD = NOW - (AUDIT_KEEP_DAYS + 1) * DAY;
const RECENT = NOW - (AUDIT_KEEP_DAYS - 1) * DAY;

async function event(at: number, action: string, accountId: string | null = "acc_live"): Promise<void> {
  await env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, actor, action) VALUES (?, ?, 'customer', ?)").bind(at, accountId, action).run();
}

async function rows(): Promise<string[]> {
  const r = await env.PLATFORM_DB.prepare("SELECT action || '@' || COALESCE(account_id, '-') || '@' || (at < ?) AS k FROM audit_events ORDER BY k")
    .bind(NOW - AUDIT_KEEP_DAYS * DAY)
    .all<{ k: string }>();
  return r.results.map((x) => x.k);
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.PLATFORM_DB.prepare("DELETE FROM audit_events").run();
});

describe("audit log retention", () => {
  it("deletes everything older than two years except an account's security record", async () => {
    await event(OLD, "account.signed_in");
    await event(OLD, "handoff.issued");
    await event(OLD, "billing.changed", null);
    await event(RECENT, "account.signed_in");
    for (const action of KEPT_ACTIONS) await event(OLD, action);
    // A kept action with no account to keep it for expires like the rest.
    await event(OLD, "account.created", null);
    expect(await auditCleanup(env.PLATFORM_DB, NOW)).toBe(4);
    expect(await rows()).toEqual(["account.signed_in@acc_live@0", ...KEPT_ACTIONS.map((a) => `${a}@acc_live@1`)].sort());
  });

  it("lets a security record expire once its mark is cleared, as deleting the account does", async () => {
    await event(OLD, "support.handoff_issued", "acc_gone");
    await event(RECENT, "support.handoff_issued", "acc_gone");
    await env.PLATFORM_DB.prepare("UPDATE audit_events SET kept = 0 WHERE account_id = 'acc_gone'").run();
    await auditCleanup(env.PLATFORM_DB, NOW);
    expect(await rows()).toEqual(["support.handoff_issued@acc_gone@0"]);
  });

  it("keeps deleting batch after batch until it is caught up, within its time", async () => {
    const insert = env.PLATFORM_DB.prepare("INSERT INTO audit_events (at, account_id, actor, action) VALUES (?, 'acc_live', 'system', 'account.signed_in')");
    await env.PLATFORM_DB.batch(Array.from({ length: 2 * AUDIT_DELETE_BATCH + 5 }, (_, i) => insert.bind(OLD - i)));
    expect(await auditCleanup(env.PLATFORM_DB, NOW)).toBe(2 * AUDIT_DELETE_BATCH + 5);
    expect(await rows()).toEqual([]);
    // Out of time after the first batch: the rest waits for the next run.
    await env.PLATFORM_DB.batch(Array.from({ length: AUDIT_DELETE_BATCH + 5 }, (_, i) => insert.bind(OLD - i)));
    let t = 0;
    expect(await auditCleanup(env.PLATFORM_DB, NOW, () => (t += 30_000), 20_000)).toBe(AUDIT_DELETE_BATCH);
    expect(await auditCleanup(env.PLATFORM_DB, NOW)).toBe(5);
  });

  it("marks the kept actions by the migration's trigger, the same list as the code", async () => {
    for (const action of [...KEPT_ACTIONS, "account.signed_in"]) await event(NOW, action);
    const kept = await env.PLATFORM_DB.prepare("SELECT action FROM audit_events WHERE kept = 1 ORDER BY action").all<{ action: string }>();
    expect(kept.results.map((r) => r.action)).toEqual([...KEPT_ACTIONS].sort());
  });

  it("reads by time over the partial index of rows that may expire, never a kept row", async () => {
    const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${EXPIRED_EVENTS_SQL}`).bind(OLD).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    expect(details).toMatch(/USING (COVERING )?INDEX idx_audit_events_expiring \(at<\?\)/);
    expect(details).not.toMatch(/SCAN audit_events(?! USING)/);
  });
});
