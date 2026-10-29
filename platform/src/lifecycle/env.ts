/**
 * The lifecycle jobs' dependencies from the platform's env. Emails need only
 * the mailer; exports and deletions also need provisioning's settings (the
 * Cloudflare API, PLATFORM_KEY) and the EXPORTS bucket, and wait for them.
 */

import type { PlatformCapability } from "../../../src/shared/hosted-contract";
import { HttpCloudflareApi } from "../cloudflare/http";
import type { PlatformEnv } from "../env";
import { mailerFromEnv } from "../mail";
import { provisioningSettings, provisioningSetup } from "../provisioning-env";
import type { TenantRecord } from "../tenants";
import { D1BillingView } from "./billing-view";
import type { ExportDeps } from "./exports";
import type { LifecycleDeps } from "./jobs";

export function exportDepsFromEnv(env: PlatformEnv): Omit<ExportDeps, "db" | "now"> | null {
  const settings = provisioningSettings(env);
  if (!settings.ok || !env.EXPORTS) return null;
  return { api: new HttpCloudflareApi({ accountId: settings.accountId, apiToken: settings.apiToken }), bucket: env.EXPORTS };
}

export function lifecycleDepsFromEnv(env: PlatformEnv, capability: (tenant: TenantRecord) => PlatformCapability): LifecycleDeps {
  const provisioning = provisioningSetup(env, capability);
  return {
    db: env.PLATFORM_DB,
    billing: new D1BillingView(env.PLATFORM_DB),
    mailer: mailerFromEnv(env),
    hostedDomain: env.HOSTED_DOMAIN,
    exports: exportDepsFromEnv(env),
    provisioning: provisioning.ok ? provisioning.deps : null,
  };
}
