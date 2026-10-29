import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INTERNAL_HEADER, PLAN_LIMITS, type PlatformCapability } from "../../src/shared/hosted-contract";
import { createApp } from "../src/app";
import { TenantCapability } from "../src/capability";
import { DISPATCH_LIMITS } from "../src/dispatch";
import type { PlatformEnv } from "../src/env";
import { TENANT_CACHE_MS, cachedTenantBySlug, clearTenantCache, forgetTenant } from "../src/tenants";
import { FakeDispatcher, echoWorker } from "./fake-dispatcher";

const DOMAIN = "openping.test";
const CALL_ID = "fixedcallid0123456789abcdef01234";

let dispatcher: FakeDispatcher;

const app = createApp({
  dispatcher: () => dispatcher,
  capability: (e, _ctx, tenant) => new TenantCapability(e.PLATFORM_DB, tenant.id, tenant.accountId) as PlatformCapability,
  newCallId: () => CALL_ID,
});

// The platform's env as the tests have it: no namespace or queue (the fake stands in).
const platformEnv = env as unknown as PlatformEnv;

async function request(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), platformEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let seq = 0;
async function addTenant(fields: {
  slug: string;
  status?: string;
  plan?: string;
  provisionState?: string;
  limitOverrides?: string | null;
}): Promise<{ id: string; scriptName: string }> {
  seq++;
  const id = `tenant${String(seq).padStart(10, "0")}`;
  const accountId = `acc_${seq}`;
  const now = Date.now();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      accountId,
      `owner${seq}@example.com`,
      now,
      now,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, limit_overrides, trial_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      accountId,
      fields.slug,
      `t-${id}`,
      fields.status ?? "active",
      fields.plan ?? "hosted",
      fields.provisionState ?? "ready",
      fields.limitOverrides ?? null,
      now + 14 * 86_400_000,
      now,
      now,
    ),
  ]);
  return { id, scriptName: `t-${id}` };
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(() => {
  clearTenantCache();
  dispatcher = new FakeDispatcher();
});

describe("the platform database", () => {
  it("has every table after migrations", async () => {
    const rows = await env.PLATFORM_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual([
      "account_identities",
      "accounts",
      "audit_events",
      "auth_ceremonies",
      "billing_emails",
      "billing_locks",
      "email_changes",
      "email_logins",
      "email_recipients",
      "escrowed_keys",
      "export_keys",
      "lifecycle_locks",
      "lifecycle_notices",
      "platform_heartbeats",
      "platform_sessions",
      "rate_limits",
      "release_locks",
      "release_requests",
      "release_tenants",
      "releases",
      "scheduler_days",
      "scheduler_minutes",
      "scheduler_stats",
      "slug_holds",
      "stripe_events",
      "subscriptions",
      "tenant_email_usage",
      "tenant_exports",
      "tenant_usage",
      "tenants",
      "waitlist_entries",
    ]);
  });

  it("refuses a tenant status or plan outside the contract", async () => {
    await expect(addTenant({ slug: "badstatus", status: "frozen" })).rejects.toThrow(/CHECK/);
    await expect(addTenant({ slug: "badplan", plan: "enterprise" })).rejects.toThrow(/CHECK/);
  });

  it("refuses a passkey identity without its key", async () => {
    const now = Date.now();
    await env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_pk', 'pk@example.com', ?, ?)")
      .bind(now, now)
      .run();
    const insert = (publicKey: string | null) =>
      env.PLATFORM_DB.prepare(
        "INSERT INTO account_identities (id, account_id, kind, subject, public_key, alg, created_at) VALUES (?, 'acc_pk', 'passkey', ?, ?, ?, ?)",
      )
        .bind(`idn_${publicKey ?? "none"}`, `cred_${publicKey ?? "none"}`, publicKey, publicKey ? -7 : null, now)
        .run();
    await expect(insert(null)).rejects.toThrow(/CHECK/);
    await expect(insert("pQECAyYgASFYIA")).resolves.toBeTruthy();
  });
});

describe("app.<domain>", () => {
  it("serves the platform's home page", async () => {
    const res = await request(`https://app.${DOMAIN}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("OpenPing Hosted isn't open for sign-ups yet");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("answers /healthz with the database's state", async () => {
    const res = await request(`https://app.${DOMAIN}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, service: "openping-platform", db: "ok" });
  });

  it("answers an unknown path with its 404 page", async () => {
    const res = await request(`https://app.${DOMAIN}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page not found");
  });

  it("redirects the apex and www to app.<domain>, keeping the path", async () => {
    for (const host of [DOMAIN, `www.${DOMAIN}`]) {
      const res = await request(`https://${host}/pricing?x=1`, { redirect: "manual" });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`https://app.${DOMAIN}/pricing?x=1`);
    }
  });

  it("serves nothing on hosts that aren't ours", async () => {
    for (const host of ["example.com", `a.b.${DOMAIN}`, `${DOMAIN}.evil.test`]) {
      const res = await request(`https://${host}/`);
      expect(res.status, host).toBe(404);
      expect(await res.text()).toContain("isn't part of OpenPing Hosted");
    }
    expect(dispatcher.calls).toHaveLength(0);
  });
});

describe("<slug>.<domain>", () => {
  it("dispatches to the tenant's user Worker with its props and limits", async () => {
    const tenant = await addTenant({ slug: "acme" });
    dispatcher.register(tenant.scriptName, echoWorker);

    const res = await request(`https://acme.${DOMAIN}/status?x=1`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.url).toBe(`https://acme.${DOMAIN}/status?x=1`);
    expect(body.headers["cf-connecting-ip"]).toBe("203.0.113.9");
    expect(body.invocation).toBe("public");

    expect(dispatcher.calls).toHaveLength(1);
    const call = dispatcher.calls[0]!;
    expect(call.scriptName).toBe(tenant.scriptName);
    expect(call.limits).toEqual(DISPATCH_LIMITS.public);
    expect(call.props).toMatchObject({
      contract: 1,
      invocation: "public",
      callId: CALL_ID,
      tenant: {
        id: tenant.id,
        slug: "acme",
        status: "active",
        plan: "hosted",
        limits: PLAN_LIMITS.hosted,
        trialEndsAt: null,
        urls: {
          account: `https://app.${DOMAIN}/account`,
          billing: `https://app.${DOMAIN}/billing`,
          upgrade: `https://app.${DOMAIN}/billing/upgrade`,
          signIn: `https://app.${DOMAIN}/sign-in?tenant=acme`,
          signOut: `https://app.${DOMAIN}/sign-out`,
        },
      },
    });
    expect(typeof call.props.platform.audit).toBe("function");
  });

  it("passes a trial's end date and the tenant's limit overrides", async () => {
    const tenant = await addTenant({
      slug: "trialco",
      status: "trial",
      plan: "trial",
      limitOverrides: JSON.stringify({ monitors: 8, channelKinds: ["email", "nonsense"], bogus: 1 }),
    });
    dispatcher.register(tenant.scriptName, echoWorker);
    await request(`https://trialco.${DOMAIN}/`);
    const props = dispatcher.calls[0]!.props;
    expect(props.tenant.trialEndsAt).toBeTypeOf("number");
    // The valid override applies; the invalid channel list and the unknown key are ignored.
    expect(props.tenant.limits).toEqual({ ...PLAN_LIMITS.trial, monitors: 8 });
  });

  it("passes the user Worker's answer through untouched", async () => {
    const tenant = await addTenant({ slug: "teapot" });
    dispatcher.register(tenant.scriptName, () => new Response("short and stout", { status: 418, headers: { "x-own": "yes" } }));
    const res = await request(`https://teapot.${DOMAIN}/`);
    expect(res.status).toBe(418);
    expect(res.headers.get("x-own")).toBe("yes");
    expect(await res.text()).toBe("short and stout");
  });

  it("shows a clean 404 page for an unknown, reserved or invalid slug", async () => {
    for (const slug of ["nobody-here", "support", "xn--80ak6aa92e", "ab"]) {
      const res = await request(`https://${slug}.${DOMAIN}/`);
      expect(res.status, slug).toBe(404);
      const html = await res.text();
      expect(html).toContain("no OpenPing here");
      expect(html).toContain(`${slug}.${DOMAIN}`);
    }
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("shows the suspended page instead of dispatching", async () => {
    const tenant = await addTenant({ slug: "lapsed", status: "suspended" });
    dispatcher.register(tenant.scriptName, echoWorker);
    const res = await request(`https://lapsed.${DOMAIN}/`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("This OpenPing is paused");
    expect(html).toContain(`https://app.${DOMAIN}/account`);
    expect(html).toContain("support@n8builds.dev");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("shows the setting-up page until provisioning is done, and 404 once deleting", async () => {
    const setting = await addTenant({ slug: "newco", provisionState: "uploaded" });
    dispatcher.register(setting.scriptName, echoWorker);
    const res = await request(`https://newco.${DOMAIN}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.text()).toContain("Almost ready");

    const leaving = await addTenant({ slug: "goneco", provisionState: "deleting" });
    dispatcher.register(leaving.scriptName, echoWorker);
    expect((await request(`https://goneco.${DOMAIN}/`)).status).toBe(404);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("shows the unavailable page when the user Worker is missing or throws", async () => {
    await addTenant({ slug: "ghost" });
    const missing = await request(`https://ghost.${DOMAIN}/`);
    expect(missing.status).toBe(502);
    expect(await missing.text()).toContain("be reached right now");

    const broken = await addTenant({ slug: "broken" });
    dispatcher.register(broken.scriptName, () => {
      throw new Error("boom");
    });
    const res = await request(`https://broken.${DOMAIN}/`);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("boom");
  });
});

describe("internal paths and the internal header (security)", () => {
  it("never lets a public request reach /__platform/*, even carrying the internal header", async () => {
    const tenant = await addTenant({ slug: "victim" });
    dispatcher.register(tenant.scriptName, echoWorker);

    for (const path of ["/__platform/scheduled", "/__platform/health", "/__platform", "/__platform/anything"]) {
      for (const method of ["GET", "POST"]) {
        const res = await request(`https://victim.${DOMAIN}${path}`, {
          method,
          headers: { [INTERNAL_HEADER]: CALL_ID, "content-type": "application/json" },
          body: method === "POST" ? JSON.stringify({ runId: "x", scheduledTime: 0, cron: "* * * * *" }) : undefined,
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("also refuses internal paths for unknown tenants, so they can't be probed", async () => {
    const res = await request(`https://nobody-at-all.${DOMAIN}/__platform/health`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("strips every x-openping-* header from public traffic before dispatching", async () => {
    const tenant = await addTenant({ slug: "stripped" });
    dispatcher.register(tenant.scriptName, echoWorker);
    const res = await request(`https://stripped.${DOMAIN}/api/monitors`, {
      headers: {
        [INTERNAL_HEADER]: CALL_ID,
        "X-OpenPing-Platform": CALL_ID,
        "x-openping-tenant": "someone-else",
        "x-other": "kept",
      },
    });
    const body = (await res.json()) as any;
    expect(Object.keys(body.headers).filter((h) => h.startsWith("x-openping-"))).toEqual([]);
    expect(body.headers["x-other"]).toBe("kept");
    expect(body.invocation).toBe("public");
    // And what the fake recorded is exactly what the tenant saw.
    expect(dispatcher.calls[0]!.request.headers.get(INTERNAL_HEADER)).toBeNull();
  });
});

describe("the tenant cache", () => {
  it("keeps a ready tenant briefly, an unknown slug more briefly, and a provisioning one not at all", async () => {
    const db = env.PLATFORM_DB;
    await addTenant({ slug: "cachedco" });
    const first = await cachedTenantBySlug(db, "cachedco", 1_000);
    await db.prepare("UPDATE tenants SET status = 'suspended' WHERE slug = 'cachedco'").run();
    expect((await cachedTenantBySlug(db, "cachedco", 1_000 + TENANT_CACHE_MS - 1))!.status).toBe(first!.status);
    expect((await cachedTenantBySlug(db, "cachedco", 1_000 + TENANT_CACHE_MS))!.status).toBe("suspended");
    // forgetTenant takes a change made in this isolate at once.
    await db.prepare("UPDATE tenants SET status = 'active' WHERE slug = 'cachedco'").run();
    forgetTenant("cachedco");
    expect((await cachedTenantBySlug(db, "cachedco", 1_000 + TENANT_CACHE_MS + 1))!.status).toBe("active");

    expect(await cachedTenantBySlug(db, "laterco", 5_000)).toBeNull();
    await addTenant({ slug: "laterco", provisionState: "uploaded" });
    expect(await cachedTenantBySlug(db, "laterco", 5_001)).toBeNull();
    expect((await cachedTenantBySlug(db, "laterco", 10_000))!.provisionState).toBe("uploaded");
    await db.prepare("UPDATE tenants SET provision_state = 'ready' WHERE slug = 'laterco'").run();
    expect((await cachedTenantBySlug(db, "laterco", 10_001))!.provisionState).toBe("ready");
  });
});
