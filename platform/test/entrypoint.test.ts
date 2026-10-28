import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import "../src/index";

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
});
