import { describe, expect, it } from "vitest";

import { generateHandoffKeyPair } from "../../src/shared/hosted-contract";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey } from "../src/keys";
import { captureLogs, type LogLine } from "../src/log";
import { provisioningSettings, provisioningSetup, tenantLogSampling } from "../src/provisioning-env";

const base = { HOSTED_DOMAIN: "openping.test" } as PlatformEnv;

describe("provisioning settings", () => {
  it("names every setting that is missing, so provisioning stays off until the owner has set them", () => {
    expect(provisioningSettings(base)).toEqual({
      ok: false,
      missing: ["DISPATCH_NAMESPACE", "BUNDLES", "CF_ACCOUNT_ID", "CF_API_TOKEN", "PLATFORM_KEY", "HANDOFF_PUBLIC_KEY"],
    });
  });

  it("refuses malformed values, not just empty ones", () => {
    const result = provisioningSettings({
      ...base,
      DISPATCH_NAMESPACE: "openping-tenants",
      BUNDLES: {} as R2Bucket,
      CF_ACCOUNT_ID: "my-account",
      CF_API_TOKEN: "token",
      PLATFORM_KEY: "not-32-bytes",
      HANDOFF_PUBLIC_KEY: "abc",
    });
    expect(result).toEqual({ ok: false, missing: ["CF_ACCOUNT_ID", "PLATFORM_KEY", "HANDOFF_PUBLIC_KEY"] });
  });

  it("builds the real client, bundle source and dispatcher once everything is set", async () => {
    const setup = provisioningSetup(
      {
        ...base,
        TENANTS: {} as DispatchNamespace,
        DISPATCH_NAMESPACE: "openping-tenants",
        BUNDLES: {} as R2Bucket,
        CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CF_API_TOKEN: "token",
        PLATFORM_KEY: generateMasterKey(),
        HANDOFF_PUBLIC_KEY: ` ${(await generateHandoffKeyPair()).publicKey} `,
      },
      () => {
        throw new Error("not called");
      },
    );
    expect(setup.ok).toBe(true);
    if (setup.ok) {
      expect(setup.deps.config.namespace).toBe("openping-tenants");
      expect(setup.deps.config.handoffPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // TENANT_LOG_SAMPLING unset: every invocation of every user Worker is logged.
      expect(setup.deps.config.tenantLogSampling).toBe(1);
    }
  });
});

describe("TENANT_LOG_SAMPLING", () => {
  it("is a rate from 0 to 1, and 1 when empty", () => {
    expect(tenantLogSampling(undefined)).toBe(1);
    expect(tenantLogSampling(" ")).toBe(1);
    expect(tenantLogSampling("0.25")).toBe(0.25);
    expect(tenantLogSampling("0")).toBe(0);
    expect(tenantLogSampling("1.0")).toBe(1);
  });

  it("falls back to 1 with a warning for a value that isn't one, so a typo never stops provisioning", async () => {
    for (const bad of ["1.5", "-0.1", "half", "50%", "1e-1"]) expect(tenantLogSampling(bad)).toBeNull();
    const lines: LogLine[] = [];
    const restore = captureLogs((l) => lines.push(l));
    try {
      const result = provisioningSettings({
        ...base,
        DISPATCH_NAMESPACE: "openping-tenants",
        BUNDLES: {} as R2Bucket,
        CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        CF_API_TOKEN: "token",
        PLATFORM_KEY: generateMasterKey(),
        HANDOFF_PUBLIC_KEY: (await generateHandoffKeyPair()).publicKey,
        TENANT_LOG_SAMPLING: "half",
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.config.tenantLogSampling).toBe(1);
      expect(lines.map((l) => l.event)).toEqual(["config.tenant_log_sampling_invalid"]);
    } finally {
      restore();
    }
  });
});

describe("starter mode and addresses settings", () => {
  const complete = async (): Promise<PlatformEnv> => ({
    ...base,
    BUNDLES: {} as R2Bucket,
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CF_API_TOKEN: "token",
    PLATFORM_KEY: generateMasterKey(),
    HANDOFF_PUBLIC_KEY: (await generateHandoffKeyPair()).publicKey,
  });

  it("needs no dispatch namespace in starter mode, but Custom Domain addresses and their zone", async () => {
    const env = { ...(await complete()), TENANT_MODE: "starter" };
    expect(provisioningSettings(env)).toEqual({ ok: false, missing: ["TENANT_ADDRESSES"] });
    expect(provisioningSettings({ ...env, TENANT_ADDRESSES: "custom_domains" })).toEqual({ ok: false, missing: ["CF_ZONE_ID"] });
    const ok = provisioningSettings({ ...env, TENANT_ADDRESSES: "custom_domains", CF_ZONE_ID: "fedcba9876543210fedcba9876543210" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.mode).toBe("starter");
      expect(ok.config.namespace).toBe("");
      expect(ok.config.addresses).toEqual({ kind: "custom_domains", zoneId: "fedcba9876543210fedcba9876543210", dispatchService: "openping-platform" });
    }
  });

  it("names a mode or an address kind it doesn't know", async () => {
    const env = { ...(await complete()), DISPATCH_NAMESPACE: "ns" };
    expect(provisioningSettings({ ...env, TENANT_MODE: "cheap" })).toEqual({ ok: false, missing: ["TENANT_MODE"] });
    expect(provisioningSettings({ ...env, TENANT_ADDRESSES: "subdomain" })).toEqual({ ok: false, missing: ["TENANT_ADDRESSES"] });
    const dispatch = provisioningSettings(env);
    expect(dispatch.ok && dispatch.config.mode).toBe("dispatch");
    expect(dispatch.ok && dispatch.config.addresses).toEqual({ kind: "wildcard" });
  });
});
