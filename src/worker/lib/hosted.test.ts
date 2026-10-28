import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, type TenantInfo, type TenantProps } from "../../shared/hosted-contract";
import type { AppEnv, Env } from "../types";
import { devTenantProps, hostedGate, hostedMode, hostedProps, refuseWhenHosted } from "./hosted";

const TENANT = "abcdefgh12345678";

const tenant: TenantInfo = {
  id: TENANT,
  slug: "acme",
  status: "active",
  plan: "hosted",
  limits: PLAN_LIMITS.hosted,
  trialEndsAt: null,
  urls: {
    account: "https://app.example.test/account",
    billing: "https://app.example.test/billing",
    upgrade: "https://app.example.test/billing/upgrade",
    signIn: "https://app.example.test/sign-in",
    signOut: "https://app.example.test/sign-out",
  },
};

const props = (over: Partial<TenantProps> = {}): TenantProps => ({
  contract: 1,
  invocation: "public",
  callId: "0123456789abcdef0123456789abcdef",
  tenant,
  platform: {
    sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
    reportUsage: async () => {},
    audit: async () => {},
  },
  ...over,
});

/** A context the way workerd hands one to the Worker, with these props. */
const ctx = (p: unknown): ExecutionContext =>
  ({ waitUntil() {}, passThroughOnException() {}, props: p }) as unknown as ExecutionContext;

/** A tiny app with the gate, one managed route and one that echoes what it saw. */
function app(dev = false) {
  const a = new Hono<AppEnv>();
  a.use("*", hostedGate({ dev }));
  a.use("/managed/*", refuseWhenHosted);
  a.get("/managed/thing", (c) => c.json({ reached: true }));
  a.get("/echo", (c) => c.json({ tenant: hostedProps(c)?.tenant.id ?? null }));
  return a;
}

const hostedEnv = (over: Partial<Env> = {}) => ({ HOSTED_MODE: "1", TENANT_ID: TENANT, ...over }) as Env;

describe("hosted mode switch", () => {
  it("is off unless HOSTED_MODE is exactly \"1\"", () => {
    expect(hostedMode({ HOSTED_MODE: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1"]) expect(hostedMode({ HOSTED_MODE: value })).toBe(false);
  });
});

describe("hostedGate on a plain install", () => {
  it("never reads props and never refuses", async () => {
    // Even well-formed props for a tenant change nothing without HOSTED_MODE.
    const res = await app().request("/echo", {}, {} as Env, ctx(props()));
    expect(await res.json()).toEqual({ tenant: null });
    const managed = await app().request("/managed/thing", {}, { HOSTED_MODE: "0" } as Env, ctx(undefined));
    expect(await managed.json()).toEqual({ reached: true });
  });

  it("works without an execution context at all", async () => {
    expect((await app().request("/echo", {}, {} as Env)).status).toBe(200);
  });
});

describe("hostedGate in hosted mode", () => {
  it("keeps this call's props on the request", async () => {
    const res = await app().request("/echo", {}, hostedEnv(), ctx(props()));
    expect(await res.json()).toEqual({ tenant: TENANT });
  });

  it("answers 503 without props, with another contract or for another tenant", async () => {
    for (const p of [undefined, {}, props({ contract: 2 as 1 }), props({ tenant: { ...tenant, id: "zzzzzzzzzzzzzzzz" } })]) {
      const res = await app().request("/echo", {}, hostedEnv(), ctx(p));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "hosted_unavailable" });
    }
  });

  it("answers 503 when TENANT_ID is missing or malformed", async () => {
    for (const id of [undefined, "", "ACME"]) {
      const res = await app().request("/echo", {}, hostedEnv({ TENANT_ID: id }), ctx(props()));
      expect(res.status).toBe(503);
    }
  });

  it("refuses managed routes with 404 managed_by_platform", async () => {
    const res = await app().request("/managed/thing", {}, hostedEnv(), ctx(props()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "managed_by_platform" });
  });
});

describe("the development seam", () => {
  const devEnv = hostedEnv({ HOSTED_DEV_TENANT: JSON.stringify(tenant) });

  it("is ignored outside a development build, whatever the vars say", async () => {
    expect(devTenantProps(devEnv, false)).toBeNull();
    expect((await app(false).request("/echo", {}, devEnv, ctx({}))).status).toBe(503);
  });

  it("stands in for the dispatcher's props under npm run dev", async () => {
    const p = devTenantProps(devEnv, true);
    expect(p?.tenant).toEqual(tenant);
    expect(p?.invocation).toBe("public");
    const res = await app(true).request("/echo", {}, devEnv, ctx({}));
    expect(await res.json()).toEqual({ tenant: TENANT });
  });

  it("refuses dev props that don't describe a valid tenant, or another tenant", async () => {
    expect(devTenantProps(hostedEnv({ HOSTED_DEV_TENANT: "{not json" }), true)).toBeNull();
    expect(devTenantProps(hostedEnv({ HOSTED_DEV_TENANT: JSON.stringify({ ...tenant, urls: {} }) }), true)).toBeNull();
    const other = hostedEnv({ HOSTED_DEV_TENANT: JSON.stringify({ ...tenant, id: "zzzzzzzzzzzzzzzz" }) });
    expect((await app(true).request("/echo", {}, other, ctx({}))).status).toBe(503);
  });

  it("never overrides real props from the dispatcher", async () => {
    const devOther = hostedEnv({ HOSTED_DEV_TENANT: JSON.stringify({ ...tenant, slug: "dev" }) });
    const a = new Hono<AppEnv>();
    a.use("*", hostedGate({ dev: true }));
    a.get("/slug", (c) => c.json({ slug: hostedProps(c)?.tenant.slug }));
    expect(await (await a.request("/slug", {}, devOther, ctx(props()))).json()).toEqual({ slug: "acme" });
  });
});
