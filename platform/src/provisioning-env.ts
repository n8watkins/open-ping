/**
 * Building provisioning's dependencies from the platform's env, in one
 * place, with every missing or malformed setting named. Until the owner has
 * set them all (platform/README.md, "Owner setup"), provisioning is off and
 * says why, instead of failing halfway through a sign-up.
 */

import { base64urlDecode, type PlatformCapability } from "../../src/shared/hosted-contract";
import { R2BundleSource } from "./bundle";
import { HttpCloudflareApi } from "./cloudflare/http";
import { NamespaceDispatcher, type TenantDispatcher } from "./dispatch";
import { HttpsTenantDispatcher, RuntimeDispatcher } from "./starter";
import type { TenantRuntime } from "./tenants";
import type { PlatformEnv } from "./env";
import { isValidPlatformKey } from "./keys";
import type { ProvisioningConfig, ProvisioningDeps } from "./provisioning";
import type { AddressConfig } from "./addresses";
import type { TenantRecord } from "./tenants";
import { log } from "./log";

export type ProvisioningSetup = { ok: true; deps: ProvisioningDeps } | { ok: false; missing: string[] };

/** The platform Worker's own name, which customers' Custom Domains route to in dispatch mode (platform/wrangler.jsonc `name`). */
export const DEFAULT_PLATFORM_WORKER = "openping-platform";

/** Cloudflare zone ids are 32 hex characters. */
const ZONE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * TENANT_ADDRESSES (src/addresses.ts): "wildcard" (the default) or
 * "custom_domains", which also needs CF_ZONE_ID. Null for anything else.
 */
export function addressSettings(env: PlatformEnv): { ok: true; config: AddressConfig } | { ok: false; missing: string[] } {
  const kind = env.TENANT_ADDRESSES?.trim() || "wildcard";
  if (kind === "wildcard") return { ok: true, config: { kind: "wildcard" } };
  if (kind !== "custom_domains") return { ok: false, missing: ["TENANT_ADDRESSES"] };
  const zoneId = env.CF_ZONE_ID?.trim() ?? "";
  if (!ZONE_ID_PATTERN.test(zoneId)) return { ok: false, missing: ["CF_ZONE_ID"] };
  return { ok: true, config: { kind: "custom_domains", zoneId, dispatchService: env.PLATFORM_WORKER_NAME?.trim() || DEFAULT_PLATFORM_WORKER } };
}

/** TENANT_MODE: where new tenants run; "dispatch" when empty, null for anything else. */
export function tenantMode(env: Pick<PlatformEnv, "TENANT_MODE">): TenantRuntime | null {
  const value = env.TENANT_MODE?.trim() || "dispatch";
  return value === "dispatch" || value === "starter" ? value : null;
}

/**
 * The dispatcher for every call the platform makes to a tenant: the dispatch
 * namespace for dispatch tenants (when the TENANTS binding exists), signed
 * HTTPS for starter ones (when PLATFORM_KEY can open their secrets).
 */
export function tenantDispatcher(env: PlatformEnv): TenantDispatcher {
  return new RuntimeDispatcher({
    dispatch: env.TENANTS ? new NamespaceDispatcher(env.TENANTS) : null,
    starter: isValidPlatformKey(env.PLATFORM_KEY) ? new HttpsTenantDispatcher({ db: env.PLATFORM_DB, platformKey: env.PLATFORM_KEY }) : null,
  });
}

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
  const mode = tenantMode(env);
  if (mode === null) missing.push("TENANT_MODE");
  // Starter mode needs no namespace: its tenants are ordinary Workers.
  if (mode !== "starter" && !env.DISPATCH_NAMESPACE) missing.push("DISPATCH_NAMESPACE");
  if (!env.BUNDLES) missing.push("BUNDLES");
  if (!env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID)) missing.push("CF_ACCOUNT_ID");
  if (!env.CF_API_TOKEN) missing.push("CF_API_TOKEN");
  if (!isValidPlatformKey(env.PLATFORM_KEY)) missing.push("PLATFORM_KEY");
  if (base64urlDecode(env.HANDOFF_PUBLIC_KEY?.trim() ?? "")?.length !== 32) missing.push("HANDOFF_PUBLIC_KEY");
  const addresses = addressSettings(env);
  if (!addresses.ok) missing.push(...addresses.missing);
  // Each starter tenant is its own Worker, reached at its own Custom Domain.
  else if (mode === "starter" && addresses.config.kind !== "custom_domains") missing.push("TENANT_ADDRESSES");
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
      namespace: env.DISPATCH_NAMESPACE ?? "",
      mode: mode ?? "dispatch",
      platformKey: env.PLATFORM_KEY!,
      handoffPublicKey: env.HANDOFF_PUBLIC_KEY!.trim(),
      tenantLogSampling: sampling,
      addresses: addresses.ok ? addresses.config : { kind: "wildcard" },
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
      dispatcher: tenantDispatcher(env),
      capability,
      config: settings.config,
    },
  };
}
