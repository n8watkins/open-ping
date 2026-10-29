import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import type { PlatformEnv } from "../src/env";

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

describe("the TenantPlatform entrypoint (what props.platform is in production)", () => {
  it("is bound to the tenant in its props: an audit call lands on that tenant only", async () => {
    const stub = exports.TenantPlatform({ props: { tenantId: "entrypoint000001", accountId: "acc_ep" } });
    await stub.audit({ action: "session.created", actor: "customer", at: 0 });
    const rows = await env.PLATFORM_DB.prepare("SELECT tenant_id, account_id, action FROM audit_events WHERE tenant_id = ?")
      .bind("entrypoint000001")
      .all();
    expect(rows.results).toEqual([{ tenant_id: "entrypoint000001", account_id: "acc_ep", action: "session.created" }]);
  });

  it("serves the platform's routes through the default export", async () => {
    const res = await exports.default.fetch("https://app.openping.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("writes the cron's heartbeat on its own, so it lands even when the rest of the tick fails", async () => {
    await env.PLATFORM_DB.prepare("DELETE FROM platform_heartbeats").run();
    const db = env.PLATFORM_DB;
    // Every batch fails (the cleanup, the trial sweep's writes); single statements still go through.
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") return () => Promise.reject(new Error("D1 overloaded"));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const queue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue;
    const ctx = createExecutionContext();
    const at = Date.UTC(2026, 10, 2, 9, 1, 0);
    await worker.scheduled(createScheduledController({ scheduledTime: at, cron: "* * * * *" }), { ...(env as unknown as PlatformEnv), PLATFORM_DB: flaky, SCHEDULE_QUEUE: queue }, ctx);
    await waitOnExecutionContext(ctx);
    const beat = await db.prepare("SELECT at FROM platform_heartbeats WHERE name = 'cron'").first<{ at: number }>();
    expect(beat?.at).toBeGreaterThan(0);
  });
});
