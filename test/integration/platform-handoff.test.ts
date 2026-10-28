import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { PLAN_LIMITS, generateHandoffKeyPair, type HostedAuditEvent, type TenantProps } from "../../src/shared/hosted-contract";
import { handoffUrl, mintHandoffToken } from "../../platform/src/handoff";

/**
 * The two halves of the sign-in hand-off together: a token minted by the
 * platform's own code (platform/src/handoff.ts, what /open uses) is accepted
 * by the real OpenPing Worker in hosted mode, once.
 */

const TENANT = "platformhandoff1";
const ORIGIN = "https://acme.hosted.test";

let keys: { publicKey: string; privateKey: string };
const audits: HostedAuditEvent[] = [];

const ASSETS = {
  fetch: async () => new Response("<!doctype html><title>OpenPing</title>", { headers: { "content-type": "text/html; charset=utf-8" } }),
} as unknown as Fetcher;

function props(): TenantProps {
  return {
    contract: 1,
    invocation: "public",
    callId: crypto.randomUUID().replace(/-/g, ""),
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "trial",
      plan: "trial",
      limits: PLAN_LIMITS.trial,
      trialEndsAt: Date.now() + 14 * 86_400_000,
      urls: {
        account: "https://app.hosted.test/account",
        billing: "https://app.hosted.test/billing",
        upgrade: "https://app.hosted.test/billing/upgrade",
        signIn: "https://app.hosted.test/sign-in?tenant=acme",
        signOut: "https://app.hosted.test/sign-out",
      },
    },
    platform: {
      sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
      reportUsage: async () => {},
      audit: async (event) => {
        audits.push(event);
      },
    },
  };
}

async function visit(url: string, cookie?: string): Promise<Response> {
  const base = createExecutionContext();
  const ctx = { waitUntil: (p: Promise<unknown>) => base.waitUntil(p), passThroughOnException: () => {}, props: props() } as unknown as ExecutionContext;
  const headers = new Headers({ "cf-connecting-ip": "192.0.2.77" });
  if (cookie) headers.set("cookie", cookie);
  const hostedEnv = { ...env, ASSETS, HOSTED_MODE: "1", TENANT_ID: TENANT, HANDOFF_PUBLIC_KEY: keys.publicKey } as Env;
  return worker.fetch(new Request(url, { headers, redirect: "manual" }), hostedEnv, ctx);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  keys = await generateHandoffKeyPair();
});

describe("a hand-off minted by the platform", () => {
  it("signs the customer in to their OpenPing, once", async () => {
    const token = await mintHandoffToken(keys.privateKey, { tenantId: TENANT, accountId: "acc_platform", email: "owner@acme.test", now: Date.now() });
    const url = handoffUrl(ORIGIN, token);
    expect(url.startsWith(`${ORIGIN}/auth/hosted?t=v1.`)).toBe(true);

    const res = await visit(url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = res.headers.getSetCookie().find((c) => c.startsWith("op_session="));
    expect(session).toBeTruthy();

    const me = await (await visit(`${ORIGIN}/api/auth/me`, session!.split(";")[0])).json<Record<string, unknown>>();
    expect(me).toMatchObject({ authenticated: true, identity: "owner@acme.test", identityKind: "hosted" });
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "session.created", detail: { method: "handoff", role: "customer", account: "acc_platform" } }),
    );

    // The same token a second time is a replay.
    expect((await visit(url)).status).toBe(400);
  });

  it("is refused by a tenant it wasn't minted for", async () => {
    const token = await mintHandoffToken(keys.privateKey, { tenantId: "someoneelse00001", accountId: "acc_platform", email: "owner@acme.test", now: Date.now() });
    expect((await visit(handoffUrl(ORIGIN, token))).status).toBe(400);
  });
});
