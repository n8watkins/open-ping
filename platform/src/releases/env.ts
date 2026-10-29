/**
 * Building the release runner's dependencies from the platform's env: the
 * same settings as provisioning (it uploads user Workers the same way), plus
 * the bundle bucket as the release store.
 */

import type { PlatformCapability } from "../../../src/shared/hosted-contract";
import { R2BundleSource } from "../bundle";
import { HttpCloudflareApi } from "../cloudflare/http";
import { NamespaceDispatcher } from "../dispatch";
import type { PlatformEnv } from "../env";
import { provisioningSettings } from "../provisioning-env";
import type { TenantRecord } from "../tenants";
import type { ReleaseDeps } from "./runner";

export type ReleaseSetup = { ok: true; deps: ReleaseDeps } | { ok: false; missing: string[] };

export function releaseSetup(env: PlatformEnv, capability: (tenant: TenantRecord) => PlatformCapability): ReleaseSetup {
  const settings = provisioningSettings(env);
  if (!settings.ok) return settings;
  return {
    ok: true,
    deps: {
      db: env.PLATFORM_DB,
      api: new HttpCloudflareApi({ accountId: settings.accountId, apiToken: settings.apiToken }),
      store: new R2BundleSource(env.BUNDLES!),
      dispatcher: new NamespaceDispatcher(env.TENANTS),
      capability,
      config: settings.config,
      defaultCanary: env.RELEASE_CANARY?.trim() || null,
    },
  };
}
