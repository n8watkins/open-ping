import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  INTERNAL_HEADER,
  PLATFORM_HEALTH_PATH,
  PLATFORM_SCHEDULED_PATH,
  generateHandoffKeyPair,
  handoffClaims,
  importHandoffPrivateKey,
  importHandoffPublicKey,
  isPlatformCall,
  signHandoffToken,
  verifyHandoffToken,
  type PlatformCapability,
  type TenantProps,
} from "../../src/shared/hosted-contract";
import { TenantCapability, auditEventProblem } from "../src/capability";
import { DISPATCH_LIMITS, NamespaceDispatcher, buildTenantProps, callTenant, newCallId, platformRequest } from "../src/dispatch";
import type { TenantRecord } from "../src/tenants";
import { FakeDispatcher } from "./fake-dispatcher";

const DOMAIN = "openping.test";

const TENANT: TenantRecord = {
  id: "abcdefgh12345678",
  accountId: "acc_dispatch",
  slug: "acme",
  scriptName: "t-abcdefgh12345678",
  status: "active",
  plan: "hosted",
  provisionState: "ready",
  version: "0.8.3",
  limitOverrides: null,
  trialEndsAt: null,
};

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

/** A stand-in for the TENANTS binding: records get() and answers like Cloudflare does. */
function fakeNamespace(scripts: Record<string, (req: Request) => Response>) {
  const gets: { name: string; args: unknown; options: unknown }[] = [];
  const namespace = {
    get(name: string, args?: unknown, options?: unknown) {
      gets.push({ name, args, options });
      const handler = scripts[name];
      if (!handler) throw new Error(`Worker not found: ${name}`);
      return { fetch: async (req: Request) => handler(req) } as unknown as Fetcher;
    },
  } as unknown as DispatchNamespace;
  return { namespace, gets };
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

describe("NamespaceDispatcher (the real one)", () => {
  it("calls env.TENANTS.get(name, { props }, { limits }) and returns the answer", async () => {
    const { namespace, gets } = fakeNamespace({ [TENANT.scriptName]: () => new Response("hi") });
    const props = buildTenantProps({ tenant: TENANT, hostedDomain: DOMAIN, invocation: "public", callId: newCallId(), platform: noopPlatform });
    const result = await new NamespaceDispatcher(namespace).dispatch(
      TENANT.scriptName,
      new Request("https://acme.openping.test/"),
      props,
      DISPATCH_LIMITS.public,
    );
    expect(result.kind).toBe("response");
    expect(result.kind === "response" && (await result.response.text())).toBe("hi");
    expect(gets).toEqual([{ name: TENANT.scriptName, args: { props }, options: { limits: DISPATCH_LIMITS.public } }]);
  });

  it("answers missing for a script that isn't in the namespace", async () => {
    const { namespace } = fakeNamespace({});
    const props = buildTenantProps({ tenant: TENANT, hostedDomain: DOMAIN, invocation: "public", callId: newCallId(), platform: noopPlatform });
    const result = await new NamespaceDispatcher(namespace).dispatch("t-nope", new Request("https://x.openping.test/"), props, DISPATCH_LIMITS.public);
    expect(result).toEqual({ kind: "missing" });
  });

  it("lets any other failure propagate", async () => {
    const { namespace } = fakeNamespace({
      [TENANT.scriptName]: () => {
        throw new Error("user code exploded");
      },
    });
    const props = buildTenantProps({ tenant: TENANT, hostedDomain: DOMAIN, invocation: "public", callId: newCallId(), platform: noopPlatform });
    await expect(
      new NamespaceDispatcher(namespace).dispatch(TENANT.scriptName, new Request("https://acme.openping.test/"), props, DISPATCH_LIMITS.public),
    ).rejects.toThrow("user code exploded");
  });
});

describe("platform calls (callTenant)", () => {
  it("reach the tenant's internal path with matching props and header, so the tenant's gate opens", async () => {
    const dispatcher = new FakeDispatcher();
    let gate: boolean | undefined;
    let seen: Request | undefined;
    dispatcher.register(TENANT.scriptName, async (request, props: TenantProps) => {
      seen = request;
      gate = isPlatformCall(props, request.headers.get(INTERNAL_HEADER));
      return Response.json({ ok: true });
    });

    const result = await callTenant(
      dispatcher,
      { tenant: TENANT, hostedDomain: DOMAIN, platform: noopPlatform },
      PLATFORM_SCHEDULED_PATH,
      { body: { runId: "run_1", scheduledTime: 1, cron: "* * * * *" } },
    );
    expect(result.kind).toBe("response");
    expect(gate).toBe(true);
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe(`https://acme.${DOMAIN}${PLATFORM_SCHEDULED_PATH}`);
    expect(await seen!.json()).toEqual({ runId: "run_1", scheduledTime: 1, cron: "* * * * *" });

    const call = dispatcher.calls[0]!;
    expect(call.props.invocation).toBe("platform");
    expect(call.props.callId).toMatch(/^[0-9a-f]{32}$/);
    expect(call.limits).toEqual(DISPATCH_LIMITS.platform);
  });

  it("use a new call id every time", async () => {
    const dispatcher = new FakeDispatcher().register(TENANT.scriptName, () => new Response("ok"));
    const input = { tenant: TENANT, hostedDomain: DOMAIN, platform: noopPlatform };
    await callTenant(dispatcher, input, PLATFORM_HEALTH_PATH);
    await callTenant(dispatcher, input, PLATFORM_HEALTH_PATH);
    const [a, b] = dispatcher.calls;
    expect(a!.request.method).toBe("GET");
    expect(a!.props.callId).not.toBe(b!.props.callId);
  });

  it("refuse to build a platform request for a public path", () => {
    expect(() => platformRequest(TENANT, DOMAIN, "/api/monitors", newCallId())).toThrow(/not an internal path/);
  });
});

describe("the platform capability", () => {
  it("records a tenant's audit event against that tenant, at the platform's time", async () => {
    const cap = new TenantCapability(env.PLATFORM_DB, TENANT.id, TENANT.accountId, () => 1_700_000_000_000);
    await cap.audit({ action: "session.created", actor: "customer", detail: { method: "handoff" }, at: 1 });
    const row = await env.PLATFORM_DB.prepare("SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY id DESC")
      .bind(TENANT.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      at: 1_700_000_000_000,
      account_id: TENANT.accountId,
      tenant_id: TENANT.id,
      actor: "customer",
      action: "session.created",
      detail: JSON.stringify({ method: "handoff" }),
    });
  });

  it("refuses malformed audit events from customer code", async () => {
    const cap = new TenantCapability(env.PLATFORM_DB, TENANT.id, TENANT.accountId);
    await expect(cap.audit({ action: "Not Dotted", actor: "customer", at: 0 })).rejects.toThrow(/action/);
    expect(auditEventProblem({ action: "a.b", actor: "owner" as never, at: 0 })).toBe("actor");
    expect(auditEventProblem({ action: "a.b", actor: "system", detail: { nested: {} as never }, at: 0 })).toBe("detail");
    expect(auditEventProblem({ action: "a.b", actor: "system", detail: { big: "x".repeat(3000) }, at: 0 })).toBe("detail size");
    expect(auditEventProblem({ action: "monitor.deleted", actor: "support", detail: { id: "m_1", n: 1, ok: true, none: null }, at: 0 })).toBeNull();
  });

  it("answers email_unavailable until mail is wired", async () => {
    const cap = new TenantCapability(env.PLATFORM_DB, TENANT.id, TENANT.accountId);
    expect(await cap.sendEmail({ to: ["a@example.com"], subject: "s", text: "t", category: "alert" })).toMatchObject({
      ok: false,
      error: "email_unavailable",
    });
  });
});

describe("hand-off tokens in workerd", () => {
  it("sign and verify with Ed25519 in the Workers runtime, as both sides will", async () => {
    const pair = await generateHandoffKeyPair();
    const claims = handoffClaims({ tenantId: TENANT.id, accountId: TENANT.accountId, email: "a@example.com", now: Date.now() });
    const token = await signHandoffToken(claims, await importHandoffPrivateKey(pair.privateKey));
    const result = await verifyHandoffToken(token, await importHandoffPublicKey(pair.publicKey), {
      tenantId: TENANT.id,
      now: Date.now(),
    });
    expect(result).toEqual({ ok: true, claims });
  });
});
