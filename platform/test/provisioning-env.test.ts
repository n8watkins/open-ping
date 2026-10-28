import { describe, expect, it } from "vitest";

import { generateHandoffKeyPair } from "../../src/shared/hosted-contract";
import type { PlatformEnv } from "../src/env";
import { generateMasterKey } from "../src/keys";
import { provisioningSettings, provisioningSetup } from "../src/provisioning-env";

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
    }
  });
});
