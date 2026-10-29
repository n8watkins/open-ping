import { describe, expect, it } from "vitest";

import {
  HANDOFF_CLOCK_SKEW_SECONDS,
  HANDOFF_TTL_SECONDS,
  SCHEDULED_MAX_GAP_MS,
  PLAN_LIMITS,
  base64urlDecode,
  base64urlEncode,
  checkChannelKindLimit,
  checkIntervalLimit,
  checkMonitorLimit,
  checkStatusPageLimit,
  generateHandoffKeyPair,
  handoffClaims,
  importHandoffPrivateKey,
  importHandoffPublicKey,
  isHostedMode,
  isInternalPath,
  isPlatformCall,
  isTenantProps,
  isTenantId,
  nextScheduledCall,
  parseHandoffToken,
  planLimitBody,
  signHandoffToken,
  tenantDatabaseName,
  tenantScriptName,
  validateHandoffClaims,
  verifyHandoffToken,
  type HostedUrls,
  type TenantProps,
} from "./hosted-contract";

const TENANT = "abcdefgh12345678";
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const urls: HostedUrls = {
  account: "https://app.example.test/account",
  billing: "https://app.example.test/billing",
  upgrade: "https://app.example.test/billing/upgrade",
  signIn: "https://app.example.test/sign-in",
  signOut: "https://app.example.test/sign-out",
};

async function keys() {
  const pair = await generateHandoffKeyPair();
  return {
    pair,
    signing: await importHandoffPrivateKey(pair.privateKey),
    verifying: await importHandoffPublicKey(pair.publicKey),
  };
}

describe("hosted mode switch", () => {
  it("is on only for exactly \"1\"", () => {
    expect(isHostedMode("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", 1, " 1"]) expect(isHostedMode(value)).toBe(false);
  });
});

describe("tenant props", () => {
  const props = (): TenantProps => ({
    contract: 1,
    invocation: "public",
    callId: "0123456789abcdef0123456789abcdef",
    tenant: {
      id: TENANT,
      slug: "acme",
      status: "trial",
      plan: "trial",
      limits: PLAN_LIMITS.trial,
      trialEndsAt: NOW + 14 * 86_400_000,
      urls,
    },
    platform: {
      sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
      reportUsage: async () => {},
      audit: async () => {},
    },
  });

  it("accepts well-formed props for this tenant", () => {
    expect(isTenantProps(props(), TENANT)).toBe(true);
    expect(isTenantProps(props())).toBe(true);
    expect(isTenantProps({ ...props(), invocation: "platform" }, TENANT)).toBe(true);
    expect(isTenantProps({ ...props(), tenant: { ...props().tenant, trialEndsAt: null } }, TENANT)).toBe(true);
  });

  it("refuses missing props, another contract version and another tenant", () => {
    for (const value of [undefined, null, "props", 1, {}]) expect(isTenantProps(value, TENANT)).toBe(false);
    expect(isTenantProps({ ...props(), contract: 2 }, TENANT)).toBe(false);
    expect(isTenantProps(props(), "zzzzzzzzzzzzzzzz")).toBe(false);
  });

  it("refuses a malformed tenant, call id, invocation or platform", () => {
    const tenant = props().tenant;
    const bad: unknown[] = [
      { ...props(), invocation: "visitor" },
      { ...props(), callId: "short" },
      { ...props(), platform: null },
      { ...props(), tenant: null },
      { ...props(), tenant: { ...tenant, id: "ACME" } },
      { ...props(), tenant: { ...tenant, slug: "" } },
      { ...props(), tenant: { ...tenant, status: "provisioning" } },
      { ...props(), tenant: { ...tenant, plan: "free" } },
      { ...props(), tenant: { ...tenant, limits: null } },
      { ...props(), tenant: { ...tenant, trialEndsAt: "soon" } },
      { ...props(), tenant: { ...tenant, urls: { ...urls, signIn: "javascript:alert(1)" } } },
      { ...props(), tenant: { ...tenant, urls: { ...urls, signOut: undefined } } },
    ];
    for (const value of bad) expect(isTenantProps(value, TENANT)).toBe(false);
  });
});

describe("tenant names", () => {
  it("accepts 16 lowercase letters and digits as an id", () => {
    expect(isTenantId(TENANT)).toBe(true);
    for (const bad of ["ABCDEFGH12345678", "abc", "abcdefgh1234567_", "abcdefgh123456789", 42]) {
      expect(isTenantId(bad)).toBe(false);
    }
  });

  it("derives the script and database names from the id, never the slug", () => {
    expect(tenantScriptName(TENANT)).toBe("t-abcdefgh12345678");
    expect(tenantDatabaseName(TENANT)).toBe("openping-t-abcdefgh12345678");
  });
});

describe("internal paths", () => {
  it("covers /__platform and everything under it, nothing else", () => {
    expect(isInternalPath("/__platform")).toBe(true);
    expect(isInternalPath("/__platform/scheduled")).toBe(true);
    expect(isInternalPath("/__platform/anything/else")).toBe(true);
    expect(isInternalPath("/__platformx")).toBe(false);
    expect(isInternalPath("/api/__platform/scheduled")).toBe(false);
  });

  it("lets a request through only on a platform call with the matching header", () => {
    const callId = "0123456789abcdef0123";
    expect(isPlatformCall({ invocation: "platform", callId }, callId)).toBe(true);
    expect(isPlatformCall({ invocation: "public", callId }, callId)).toBe(false);
    expect(isPlatformCall({ invocation: "platform", callId }, null)).toBe(false);
    expect(isPlatformCall({ invocation: "platform", callId }, "something-else-entirely")).toBe(false);
    expect(isPlatformCall({ invocation: "platform", callId: "short" }, "short")).toBe(false);
    expect(isPlatformCall(undefined, callId)).toBe(false);
  });
});

describe("next scheduled call", () => {
  const ran = { outcome: "ran" as const, startedAt: NOW };

  it("calls at the tenant's nextDueAt", () => {
    expect(nextScheduledCall({ ...ran, nextDueAt: NOW + 60_000 }, NOW + 1_000)).toBe(NOW + 60_000);
  });

  it("calls on the next tick when nextDueAt already passed", () => {
    expect(nextScheduledCall({ ...ran, nextDueAt: NOW - 5_000 }, NOW + 1_000)).toBeLessThanOrEqual(NOW + 1_000);
  });

  it("never waits longer than the maximum gap", () => {
    expect(nextScheduledCall({ ...ran, nextDueAt: NOW + 3_600_000 }, NOW)).toBe(NOW + SCHEDULED_MAX_GAP_MS);
    expect(SCHEDULED_MAX_GAP_MS).toBe(12 * 60 * 1000);
  });

  it("keeps the 12-minute cadence for a bundle that reports no nextDueAt", () => {
    expect(nextScheduledCall(ran, NOW)).toBe(NOW + SCHEDULED_MAX_GAP_MS);
  });

  it("calls again on the next tick after a failure, a busy lease or no answer", () => {
    const now = NOW + 2_000;
    expect(nextScheduledCall({ outcome: "failed", startedAt: NOW, nextDueAt: NOW + 600_000 }, now)).toBe(now);
    expect(nextScheduledCall({ outcome: "lease_busy", startedAt: NOW }, now)).toBe(now);
    expect(nextScheduledCall(null, now)).toBe(now);
  });
});

describe("plan limits", () => {
  it("match the Hosted plan", () => {
    expect(PLAN_LIMITS.trial).toMatchObject({ monitors: 5, statusPages: 1, minIntervalMinutes: 12, channelKinds: ["email"] });
    expect(PLAN_LIMITS.hosted).toMatchObject({ monitors: 20, statusPages: 2, minIntervalMinutes: 12, channelKinds: "all" });
    expect(PLAN_LIMITS.hosted_fast).toMatchObject({ monitors: 20, statusPages: 2, minIntervalMinutes: 1 });
  });

  it("allows creating up to the limit and refuses the one after", () => {
    expect(checkMonitorLimit(PLAN_LIMITS.hosted, 19)).toBeNull();
    const over = checkMonitorLimit(PLAN_LIMITS.hosted, 20);
    expect(over).toMatchObject({ limit: "monitors", allowed: 20, requested: 21 });
    expect(over?.message).toBe("Your plan includes 20 monitors. Remove one or upgrade to add more.");

    expect(checkStatusPageLimit(PLAN_LIMITS.trial, 0)).toBeNull();
    expect(checkStatusPageLimit(PLAN_LIMITS.trial, 1)?.message).toBe(
      "Your plan includes 1 status page. Remove one or upgrade to add more.",
    );
  });

  it("refuses intervals shorter than the plan's, and nonsense", () => {
    expect(checkIntervalLimit(PLAN_LIMITS.hosted, 12)).toBeNull();
    expect(checkIntervalLimit(PLAN_LIMITS.hosted, 60)).toBeNull();
    expect(checkIntervalLimit(PLAN_LIMITS.hosted, 5)).toMatchObject({ limit: "interval", allowed: 12, requested: 5 });
    expect(checkIntervalLimit(PLAN_LIMITS.hosted, Number.NaN)).not.toBeNull();
    expect(checkIntervalLimit(PLAN_LIMITS.hosted_fast, 1)).toBeNull();
    expect(checkIntervalLimit(PLAN_LIMITS.hosted_fast, 0.5)?.message).toBe("Checks can run at most once a minute.");
  });

  it("limits a trial to email alerts", () => {
    expect(checkChannelKindLimit(PLAN_LIMITS.trial, "email")).toBeNull();
    expect(checkChannelKindLimit(PLAN_LIMITS.trial, "slack")).toMatchObject({
      limit: "channel_kind",
      allowed: ["email"],
      requested: "slack",
      message: "Your plan includes email alerts. Upgrade to add slack alerts.",
    });
    expect(checkChannelKindLimit(PLAN_LIMITS.hosted, "webhook")).toBeNull();
  });

  it("builds the 402 body with the plan and upgrade link", () => {
    const over = checkMonitorLimit(PLAN_LIMITS.trial, 5);
    expect(over).not.toBeNull();
    expect(planLimitBody(over!, { plan: "trial", urls })).toEqual({
      error: "plan_limit",
      limit: "monitors",
      allowed: 5,
      requested: 6,
      plan: "trial",
      message: "Your plan includes 5 monitors. Remove one or upgrade to add more.",
      upgradeUrl: urls.upgrade,
    });
  });
});

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = base64urlEncode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(base64urlDecode(text)!)).toEqual(Array.from(bytes));
  });

  it("rejects padding, standard base64 and impossible lengths", () => {
    expect(base64urlDecode("AA==")).toBeNull();
    expect(base64urlDecode("a+b/")).toBeNull();
    expect(base64urlDecode("abcde")).toBeNull();
    expect(base64urlDecode("")).toBeNull();
  });
});

describe("hand-off tokens", () => {
  it("have the documented format: v1.<claims>.<64-byte signature>", async () => {
    const { signing } = await keys();
    const claims = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    const token = await signHandoffToken(claims, signing);
    const [prefix, payload, signature] = token.split(".");
    expect(prefix).toBe("v1");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(payload!)!))).toEqual(claims);
    expect(base64urlDecode(signature!)!.length).toBe(64);
    expect(claims.exp - claims.iat).toBe(HANDOFF_TTL_SECONDS);
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(claims.role).toBe("customer");
  });

  it("verify with the matching public key for the right tenant", async () => {
    const { signing, verifying } = await keys();
    const claims = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    const token = await signHandoffToken(claims, signing);
    expect(await verifyHandoffToken(token, verifying, { tenantId: TENANT, now: NOW + 1_000 })).toEqual({
      ok: true,
      claims,
    });
  });

  it("refuse another key, another tenant, a changed payload and garbage", async () => {
    const { signing, verifying } = await keys();
    const other = await keys();
    const claims = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    const token = await signHandoffToken(claims, signing);
    const expect_ = { tenantId: TENANT, now: NOW };

    expect(await verifyHandoffToken(token, other.verifying, expect_)).toEqual({ ok: false, error: "bad_signature" });
    expect(await verifyHandoffToken(token, verifying, { ...expect_, tenantId: "zzzzzzzzzzzzzzzz" })).toEqual({
      ok: false,
      error: "wrong_tenant",
    });

    // Re-encode the claims for another account, keeping the old signature.
    const [, , signature] = token.split(".");
    const forged = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...claims, sub: "acc_2" })));
    expect(await verifyHandoffToken(`v1.${forged}.${signature}`, verifying, expect_)).toEqual({
      ok: false,
      error: "bad_signature",
    });

    for (const garbage of ["", "v1", "v1.a.b", "v2." + token.slice(3), token + ".x", "x".repeat(3000)]) {
      expect(await verifyHandoffToken(garbage, verifying, expect_)).toEqual({ ok: false, error: "malformed" });
    }
  });

  it("expire after 60 seconds, with a few seconds of clock skew either way", async () => {
    const { signing, verifying } = await keys();
    const claims = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    const token = await signHandoffToken(claims, signing);
    const at = (ms: number) => verifyHandoffToken(token, verifying, { tenantId: TENANT, now: NOW + ms });

    expect((await at((HANDOFF_TTL_SECONDS + HANDOFF_CLOCK_SKEW_SECONDS - 1) * 1000)).ok).toBe(true);
    expect(await at((HANDOFF_TTL_SECONDS + HANDOFF_CLOCK_SKEW_SECONDS) * 1000)).toEqual({ ok: false, error: "expired" });
    expect((await at(-HANDOFF_CLOCK_SKEW_SECONDS * 1000)).ok).toBe(true);
    expect(await at(-(HANDOFF_CLOCK_SKEW_SECONDS + 1) * 1000)).toEqual({ ok: false, error: "not_yet_valid" });
  });

  it("refuse claims that live longer than 60 seconds or come from another issuer", () => {
    const claims = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    const expect_ = { tenantId: TENANT, now: NOW };
    expect(validateHandoffClaims({ ...claims, exp: claims.iat + 3600 }, expect_)).toBe("lifetime_too_long");
    expect(validateHandoffClaims({ ...claims, exp: claims.iat }, expect_)).toBe("lifetime_too_long");
    expect(validateHandoffClaims({ ...claims, iss: "someone" as never }, expect_)).toBe("wrong_issuer");
  });

  it("parse only well-shaped claims", async () => {
    const { signing } = await keys();
    const good = handoffClaims({ tenantId: TENANT, accountId: "acc_1", email: "a@example.com", now: NOW });
    for (const bad of [
      { ...good, v: 2 },
      { ...good, nonce: "short" },
      { ...good, email: "no-at-sign" },
      { ...good, role: "owner" },
      { ...good, iat: 1.5 },
    ]) {
      const token = await signHandoffToken(bad as never, signing);
      expect(parseHandoffToken(token)).toBeNull();
    }
  });

  it("refuse a public key of the wrong size", async () => {
    await expect(importHandoffPublicKey("AAAA")).rejects.toThrow(/32 bytes/);
  });
});
