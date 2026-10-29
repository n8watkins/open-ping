/**
 * Building provisioning's dependencies from the platform's env, in one
 * place, with every missing or malformed setting named. Until the owner has
 * set them all (platform/README.md, "Owner setup"), provisioning is off and
 * says why, instead of failing halfway through a sign-up.
 */

import { base64urlDecode, type PlatformCapability } from "../../src/shared/hosted-contract";
import { R2BundleSource } from "./bundle";
import { HttpCloudflareApi } from "./cloudflare/http";
import { NamespaceDispatcher } from "./dispatch";
import type { PlatformEnv } from "./env";
import { isValidPlatformKey } from "./keys";
import type { ProvisioningConfig, ProvisioningDeps } from "./provisioning";
import type { TenantRecord } from "./tenants";
import { log } from "./log";

export type ProvisioningSetup = { ok: true; deps: ProvisioningDeps } | { ok: false; missing: string[] };

/** TENANT_LOG_SAMPLING as a rate: 1 when empty, null when it isn't a number from 0 to 1. */
export function tenantLogSampling(value: string | undefined): number | null {
  const text = value?.trim() ?? "";
  if (!text) return 1;
  const rate = Number(text);
  return /^(0(\.\d+)?|1(\.0+)?)$/.test(text) && rate >= 0 && rate <= 1 ? rate : null;
}

/** The settings provisioning needs, or the names of the ones that are missing or malformed. */
export function provisioningSettings(
  env: PlatformEnv,
): { ok: true; config: ProvisioningConfig; accountId: string; apiToken: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!env.DISPATCH_NAMESPACE) missing.push("DISPATCH_NAMESPACE");
  if (!env.BUNDLES) missing.push("BUNDLES");
  if (!env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID)) missing.push("CF_ACCOUNT_ID");
  if (!env.CF_API_TOKEN) missing.push("CF_API_TOKEN");
  if (!isValidPlatformKey(env.PLATFORM_KEY)) missing.push("PLATFORM_KEY");
  if (base64urlDecode(env.HANDOFF_PUBLIC_KEY?.trim() ?? "")?.length !== 32) missing.push("HANDOFF_PUBLIC_KEY");
  // A bad sampling rate never stops provisioning, releases or lifecycle: it falls back to logging everything, and says so.
  let sampling = tenantLogSampling(env.TENANT_LOG_SAMPLING);
  if (sampling === null) {
    log.warn("config.tenant_log_sampling_invalid", { expected: "a number from 0 to 1", using: 1 });
    sampling = 1;
  }
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    accountId: env.CF_ACCOUNT_ID!,
    apiToken: env.CF_API_TOKEN!,
    config: {
      hostedDomain: env.HOSTED_DOMAIN,
      namespace: env.DISPATCH_NAMESPACE!,
      platformKey: env.PLATFORM_KEY!,
      handoffPublicKey: env.HANDOFF_PUBLIC_KEY!.trim(),
      tenantLogSampling: sampling,
    },
  };
}

export function provisioningSetup(
  env: PlatformEnv,
  capability: (tenant: TenantRecord) => PlatformCapability,
): ProvisioningSetup {
  const settings = provisioningSettings(env);
  if (!settings.ok) return settings;
  return {
    ok: true,
    deps: {
      db: env.PLATFORM_DB,
      api: new HttpCloudflareApi({ accountId: settings.accountId, apiToken: settings.apiToken }),
      bundles: new R2BundleSource(env.BUNDLES!),
      dispatcher: new NamespaceDispatcher(env.TENANTS),
      capability,
      config: settings.config,
    },
  };
}
