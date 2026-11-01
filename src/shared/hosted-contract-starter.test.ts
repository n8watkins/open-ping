import { describe, expect, it } from "vitest";

import {
  INTERNAL_HEADER,
  PLAN_LIMITS,
  SIGNED_CALL_HEADERS,
  SIGNED_CALL_MAX_BODY_BYTES,
  SIGNED_CALL_MAX_SKEW_MS,
  SIGNED_CALL_NONCE_RETENTION_MS,
  STARTER_TRANSPORT_ON,
  TENANT_CALL_PATHS,
  base64urlEncode,
  decodeSignedCallProps,
  deriveCallKeys,
  encodeSignedCallProps,
  generatePlatformCallSecret,
  hasSignedCallHeaders,
  hostedTransport,
  isPlatformCallSecret,
  isTenantCallPath,
  signRequest,
  signResponse,
  verifySignedRequest,
  verifySignedResponse,
  type CallKeys,
  type SignedCallProps,
} from "./hosted-contract";

/**
 * Starter mode's signed calls (docs/hosted/CONTRACT.md, section 10): what a
 * forged, tampered, replayed-onto-another-call, expired, reflected or
 * cross-tenant request gets, from the pure helpers both sides use.
 */

const TENANT = "abcdefgh12345678";
const OTHER = "zyxwvuts87654321";
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const TENANT_URL = "https://acme.openping.test/__platform/scheduled";
const PLATFORM_URL = `https://app.openping.test${TENANT_CALL_PATHS.reportUsage}`;

const urls = {
  account: "https://app.openping.test/account",
  billing: "https://app.openping.test/billing",
  upgrade: "https://app.openping.test/billing/upgrade",
  signIn: "https://app.openping.test/sign-in?tenant=acme",
  signOut: "https://app.openping.test/sign-out",
};

function props(over: Partial<SignedCallProps> = {}): SignedCallProps {
  return {
    contract: 1,
    invocation: "platform",
    callId: "0123456789abcdef0123456789abcdef",
    tenant: { id: TENANT, slug: "acme", status: "active", plan: "hosted", limits: PLAN_LIMITS.hosted, trialEndsAt: null, urls },
    ...over,
  };
}

async function setup() {
  const secret = generatePlatformCallSecret();
  const keys = await deriveCallKeys(secret);
  const otherKeys = await deriveCallKeys(generatePlatformCallSecret());
  return { secret, keys, otherKeys };
}

/** The tenant's own key lookup: its keys for its own id, nothing for any other. */
const tenantLookup = (keys: CallKeys, own = TENANT) => async (id: string) => (id === own ? keys : null);

const toTenant = (keys: CallKeys, body = '{"runId":"r1"}', over: { now?: number; props?: SignedCallProps; tenantId?: string; url?: string } = {}) =>
  signRequest(
    { method: "POST", url: over.url ?? TENANT_URL, body, headers: { "content-type": "application/json" } },
    { direction: "platform-to-tenant", tenantId: over.tenantId ?? TENANT, keys, now: over.now ?? NOW, props: over.props ?? props() },
  );

const verifyAtTenant = (request: Request, keys: CallKeys, now = NOW) =>
  verifySignedRequest(request, { direction: "platform-to-tenant", now, keysFor: tenantLookup(keys) });

/** A copy of `request` with one header changed (or removed with null). */
async function withHeader(request: Request, name: string, value: string | null): Promise<Request> {
  const headers = new Headers(request.headers);
  if (value === null) headers.delete(name);
  else headers.set(name, value);
  return new Request(request.url, { method: request.method, headers, body: await request.text() });
}

describe("starter mode switch and names", () => {
  it("is on only for exactly https", () => {
    expect(hostedTransport(STARTER_TRANSPORT_ON)).toBe("https");
    for (const v of [undefined, "", "HTTPS", "1", "dispatch", " https"]) expect(hostedTransport(v)).toBe("dispatch");
  });

  it("knows the platform's tenant call paths", () => {
    expect(isTenantCallPath(TENANT_CALL_PATHS.info)).toBe(true);
    expect(isTenantCallPath("/__tenant/v1")).toBe(true);
    expect(isTenantCallPath("/__tenant")).toBe(false);
    expect(isTenantCallPath("/account")).toBe(false);
  });

  it("makes a new 32-byte secret every time", () => {
    const a = generatePlatformCallSecret();
    const b = generatePlatformCallSecret();
    expect(isPlatformCallSecret(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isPlatformCallSecret("short")).toBe(false);
  });

  it("refuses a secret that isn't one", async () => {
    await expect(deriveCallKeys("not a secret")).rejects.toThrow(/PLATFORM_CALL_SECRET/);
  });
});

describe("signed calls, platform to tenant", () => {
  it("verifies a call signed with the tenant's secret and gives back its props, nonce and body", async () => {
    const { keys } = await setup();
    const request = await toTenant(keys);
    expect(hasSignedCallHeaders(request.headers)).toBe(true);
    expect(request.headers.get(INTERNAL_HEADER)).toBe(props().callId);
    const result = await verifyAtTenant(request, keys);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tenantId).toBe(TENANT);
    expect(result.props).toEqual(props());
    expect(result.nonceExpiresAt).toBe(NOW + SIGNED_CALL_NONCE_RETENTION_MS);
    expect(await result.request.json()).toEqual({ runId: "r1" });
  });

  it("refuses a call signed with another tenant's secret (forged)", async () => {
    const { keys, otherKeys } = await setup();
    const result = await verifyAtTenant(await toTenant(otherKeys), keys);
    expect(result).toMatchObject({ ok: false, error: "bad_signature" });
  });

  it("refuses a call for another tenant, even one signed with that tenant's own secret", async () => {
    const { keys, otherKeys } = await setup();
    const forOther = await toTenant(otherKeys, "{}", { tenantId: OTHER, props: props({ tenant: { ...props().tenant, id: OTHER } }) });
    // Tenant TENANT receives it: it has no keys for OTHER, whatever the signature.
    expect(await verifyAtTenant(forOther, keys)).toMatchObject({ ok: false, error: "wrong_tenant" });
  });

  it("refuses props for another tenant under this tenant's signature", async () => {
    const { keys } = await setup();
    const request = await toTenant(keys, "{}", { props: props({ tenant: { ...props().tenant, id: OTHER } }) });
    expect(await verifyAtTenant(request, keys)).toMatchObject({ ok: false, error: "bad_props" });
  });

  it("refuses public props: starter mode never relays a visitor", async () => {
    const { keys } = await setup();
    const request = await toTenant(keys, "{}", { props: props({ invocation: "public" }) });
    expect(await verifyAtTenant(request, keys)).toMatchObject({ ok: false, error: "bad_props" });
  });

  it("refuses an expired call and one from the future", async () => {
    const { keys } = await setup();
    const request = await toTenant(keys);
    expect(await verifyAtTenant(request.clone(), keys, NOW + SIGNED_CALL_MAX_SKEW_MS + 1)).toMatchObject({ ok: false, error: "expired" });
    expect(await verifyAtTenant(request.clone(), keys, NOW - SIGNED_CALL_MAX_SKEW_MS - 1)).toMatchObject({ ok: false, error: "not_yet_valid" });
    expect(await verifyAtTenant(request.clone(), keys, NOW + SIGNED_CALL_MAX_SKEW_MS)).toMatchObject({ ok: true });
  });

  it("keeps the nonce longer than any window it could be accepted in", () => {
    expect(SIGNED_CALL_NONCE_RETENTION_MS).toBeGreaterThan(2 * SIGNED_CALL_MAX_SKEW_MS);
  });

  it("refuses a changed body, method, path, query, host, props, call id, timestamp or nonce", async () => {
    const { keys } = await setup();
    const original = await toTenant(keys);
    const tamper: Request[] = [
      new Request(original.url, { method: "POST", headers: original.headers, body: '{"runId":"r2"}' }),
      new Request(original.url, { method: "PUT", headers: original.headers, body: '{"runId":"r1"}' }),
      new Request("https://acme.openping.test/__platform/health", { method: "POST", headers: original.headers, body: '{"runId":"r1"}' }),
      new Request(`${TENANT_URL}?x=1`, { method: "POST", headers: original.headers, body: '{"runId":"r1"}' }),
      new Request("https://other.openping.test/__platform/scheduled", { method: "POST", headers: original.headers, body: '{"runId":"r1"}' }),
      await withHeader(original.clone(), SIGNED_CALL_HEADERS.props, encodeSignedCallProps(props({ tenant: { ...props().tenant, plan: "hosted_fast" } }))),
      await withHeader(original.clone(), INTERNAL_HEADER, "ffffffffffffffffffffffffffffffff"),
      await withHeader(original.clone(), SIGNED_CALL_HEADERS.timestamp, String(NOW + 1)),
      await withHeader(original.clone(), SIGNED_CALL_HEADERS.nonce, "AAAAAAAAAAAAAAAAAAAAAA"),
    ];
    for (const request of tamper) {
      const result = await verifyAtTenant(request, keys);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(["bad_signature", "bad_props"]).toContain(result.error);
    }
  });

  it("refuses malformed headers and calls without props", async () => {
    const { keys } = await setup();
    const original = await toTenant(keys);
    for (const [name, value] of [
      [SIGNED_CALL_HEADERS.tenant, "ACME"],
      [SIGNED_CALL_HEADERS.tenant, null],
      [SIGNED_CALL_HEADERS.timestamp, "soon"],
      [SIGNED_CALL_HEADERS.nonce, "short"],
      [SIGNED_CALL_HEADERS.props, null],
    ] as const) {
      expect(await verifyAtTenant(await withHeader(original.clone(), name, value), keys)).toMatchObject({ ok: false, error: "malformed" });
    }
    expect(await verifyAtTenant(await withHeader(original.clone(), SIGNED_CALL_HEADERS.signature, "v1=AAAA"), keys)).toMatchObject({
      ok: false,
      error: "bad_signature",
    });
  });

  it("answers unsigned for a public request, even one with other x-openping headers", async () => {
    const { keys } = await setup();
    const request = new Request("https://acme.openping.test/__platform/scheduled", {
      method: "POST",
      headers: { [INTERNAL_HEADER]: props().callId, [SIGNED_CALL_HEADERS.props]: encodeSignedCallProps(props()) },
      body: "{}",
    });
    expect(hasSignedCallHeaders(request.headers)).toBe(false);
    expect(await verifyAtTenant(request, keys)).toMatchObject({ ok: false, error: "unsigned" });
  });

  it("refuses a body over the limit without reading all of it", async () => {
    const { keys } = await setup();
    const signed = await toTenant(keys, "{}");
    const big = new Request(signed.url, { method: "POST", headers: signed.headers, body: "x".repeat(SIGNED_CALL_MAX_BODY_BYTES + 1) });
    expect(await verifyAtTenant(big, keys)).toMatchObject({ ok: false, error: "body_too_large" });
    await expect(toTenant(keys, "x".repeat(SIGNED_CALL_MAX_BODY_BYTES + 1))).rejects.toThrow(/too large/);
  });

  it("drops any other x-openping header the caller passed, so only what is signed travels", async () => {
    const { keys } = await setup();
    const request = await signRequest(
      { method: "POST", url: TENANT_URL, body: "{}", headers: { "x-openping-role": "support" } },
      { direction: "platform-to-tenant", tenantId: TENANT, keys, now: NOW, props: props() },
    );
    expect(request.headers.has("x-openping-role")).toBe(false);
  });
});

describe("signed calls, tenant to platform", () => {
  const platformLookup = (byTenant: Record<string, CallKeys>) => async (id: string) => byTenant[id] ?? null;

  it("verifies a tenant's call with that tenant's keys and carries no props", async () => {
    const { keys } = await setup();
    const request = await signRequest({ method: "POST", url: PLATFORM_URL, body: '{"monitors":3}' }, { direction: "tenant-to-platform", tenantId: TENANT, keys, now: NOW });
    expect(request.headers.has(SIGNED_CALL_HEADERS.props)).toBe(false);
    const result = await verifySignedRequest(request, { direction: "tenant-to-platform", now: NOW, keysFor: platformLookup({ [TENANT]: keys }) });
    expect(result).toMatchObject({ ok: true, tenantId: TENANT, props: null });
  });

  it("refuses a tenant claiming to be another tenant (cross-tenant)", async () => {
    const { keys, otherKeys } = await setup();
    // Tenant OTHER signs with its own secret but says it is TENANT.
    const request = await signRequest({ method: "POST", url: PLATFORM_URL, body: "{}" }, { direction: "tenant-to-platform", tenantId: TENANT, keys: otherKeys, now: NOW });
    const result = await verifySignedRequest(request, { direction: "tenant-to-platform", now: NOW, keysFor: platformLookup({ [TENANT]: keys, [OTHER]: otherKeys }) });
    expect(result).toMatchObject({ ok: false, error: "bad_signature" });
  });

  it("refuses an unknown tenant without checking anything else", async () => {
    const { keys } = await setup();
    const request = await signRequest({ method: "POST", url: PLATFORM_URL, body: "{}" }, { direction: "tenant-to-platform", tenantId: OTHER, keys, now: NOW });
    const result = await verifySignedRequest(request, { direction: "tenant-to-platform", now: NOW, keysFor: platformLookup({ [TENANT]: keys }) });
    expect(result).toMatchObject({ ok: false, error: "wrong_tenant" });
  });

  it("can't be reflected: a call signed one way never verifies the other way", async () => {
    const { keys } = await setup();
    const up = await signRequest({ method: "POST", url: TENANT_URL, body: "{}" }, { direction: "tenant-to-platform", tenantId: TENANT, keys, now: NOW });
    // Even with props added, the tenant-to-platform key doesn't sign platform calls.
    const reflected = await withHeader(up, SIGNED_CALL_HEADERS.props, encodeSignedCallProps(props()));
    expect(await verifyAtTenant(reflected, keys)).toMatchObject({ ok: false, error: "bad_signature" });
    const down = await toTenant(keys, "{}", { url: PLATFORM_URL });
    const stripped = await withHeader(down, SIGNED_CALL_HEADERS.props, null);
    const result = await verifySignedRequest(stripped, { direction: "tenant-to-platform", now: NOW, keysFor: platformLookup({ [TENANT]: keys }) });
    expect(result).toMatchObject({ ok: false, error: "bad_signature" });
  });
});

describe("signed answers", () => {
  it("binds an answer to its call's nonce and its direction", async () => {
    const { keys, otherKeys } = await setup();
    const sign = { requestDirection: "platform-to-tenant" as const, tenantId: TENANT, requestNonce: "nonce-of-call-one-aaaa", keys };
    const answer = await signResponse({ status: 200, body: '{"ok":true}' }, sign);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await verifySignedResponse(answer.clone(), sign)).toEqual({ status: 200, text: '{"ok":true}' });
    // Onto another call, from another tenant, or the other way round: no.
    expect(await verifySignedResponse(answer.clone(), { ...sign, requestNonce: "nonce-of-call-two-bbbb" })).toBeNull();
    expect(await verifySignedResponse(answer.clone(), { ...sign, keys: otherKeys })).toBeNull();
    expect(await verifySignedResponse(answer.clone(), { ...sign, requestDirection: "tenant-to-platform" })).toBeNull();
    const tampered = new Response('{"ok":false}', { status: 200, headers: answer.headers });
    expect(await verifySignedResponse(tampered, sign)).toBeNull();
    const restatused = new Response(await answer.clone().text(), { status: 503, headers: answer.headers });
    expect(await verifySignedResponse(restatused, sign)).toBeNull();
    expect(await verifySignedResponse(new Response('{"ok":true}'), sign)).toBeNull();
  });
});

describe("signed call props", () => {
  it("round-trips and checks the tenant", () => {
    const header = encodeSignedCallProps(props());
    expect(decodeSignedCallProps(header, TENANT)).toEqual(props());
    expect(decodeSignedCallProps(header, OTHER)).toBeNull();
    expect(decodeSignedCallProps(base64urlEncode(new TextEncoder().encode("[]")), TENANT)).toBeNull();
    expect(decodeSignedCallProps("!!", TENANT)).toBeNull();
    expect(decodeSignedCallProps(encodeSignedCallProps(props({ contract: 2 as 1 })), TENANT)).toBeNull();
  });
});
