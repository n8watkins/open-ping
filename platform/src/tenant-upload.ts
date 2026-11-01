/**
 * Uploading a tenant's OpenPing, the same way for provisioning, the release
 * runner and a move to Workers for Platforms: where it goes, its vars and its
 * secrets follow from where it runs (tenants.runtime).
 *
 *   dispatch  a user Worker in the dispatch namespace, with the hosted vars
 *             and MASTER_KEY (docs/hosted/CONTRACT.md, section 2);
 *   starter   an ordinary Worker on the account with, besides those,
 *             HOSTED_TRANSPORT "https", PLATFORM_URL and this tenant's own
 *             PLATFORM_CALL_SECRET (section 10), and its workers.dev address
 *             turned off, so it is reached only at its Custom Domain.
 */

import { HOSTED_ENV, HOSTED_MODE_ON, STARTER_ENV, STARTER_TRANSPORT_ON } from "../../src/shared/hosted-contract";
import type { TenantBundle } from "./bundle";
import type { CloudflareApi, ScriptLocation, UploadedScript } from "./cloudflare/api";
import { uploadUserWorker } from "./cloudflare/upload";
import { appOrigin } from "./hosts";
import { ensureCallSecret } from "./keys";
import type { ProvisioningConfig } from "./provisioning";
import type { TenantRecord, TenantRuntime } from "./tenants";

/** The script's tags: find every tenant's Worker, one tenant's, or one release's. */
export function tenantTags(tenantId: string, version: string): string[] {
  return ["openping", `tenant-${tenantId}`, `release-${version}`];
}

/** Where a tenant's Worker lives: the dispatch namespace, or the account (null) in starter mode. */
export function scriptLocation(config: Pick<ProvisioningConfig, "namespace">, runtime: TenantRuntime): ScriptLocation {
  return runtime === "starter" ? null : config.namespace;
}

export interface TenantUpload {
  db: D1Database;
  api: CloudflareApi;
  config: ProvisioningConfig;
  tenant: Pick<TenantRecord, "id" | "scriptName" | "runtime">;
  bundle: TenantBundle;
  d1Id: string;
  masterKey: string;
  /** The Durable Object migration tag the script already has; null for a new script. */
  previousMigrationTag: string | null;
  now: number;
}

/** The vars every tenant gets, and the starter ones for a starter tenant. */
export function tenantVars(config: Pick<ProvisioningConfig, "handoffPublicKey" | "hostedDomain">, tenant: Pick<TenantRecord, "id" | "runtime">): Record<string, string> {
  return {
    [HOSTED_ENV.mode]: HOSTED_MODE_ON,
    [HOSTED_ENV.tenantId]: tenant.id,
    [HOSTED_ENV.handoffPublicKey]: config.handoffPublicKey,
    ...(tenant.runtime === "starter"
      ? { [STARTER_ENV.transport]: STARTER_TRANSPORT_ON, [STARTER_ENV.platformUrl]: appOrigin(config.hostedDomain) }
      : {}),
  };
}

/** Uploads the bundle as the tenant's Worker, wherever it runs. Idempotent, like uploadUserWorker. */
export async function uploadTenant(input: TenantUpload): Promise<UploadedScript> {
  const starter = input.tenant.runtime === "starter";
  const secrets: Record<string, string> = { MASTER_KEY: input.masterKey };
  if (starter) secrets[STARTER_ENV.callSecret] = await ensureCallSecret(input.db, input.tenant.id, input.config.platformKey, input.now);
  const uploaded = await uploadUserWorker(input.api, {
    namespace: scriptLocation(input.config, input.tenant.runtime),
    scriptName: input.tenant.scriptName,
    bundle: input.bundle,
    bindings: [{ type: "d1", name: "DB", database_id: input.d1Id }],
    vars: tenantVars(input.config, input.tenant),
    secrets,
    tags: tenantTags(input.tenant.id, input.bundle.version),
    previousMigrationTag: input.previousMigrationTag,
    logSampling: input.config.tenantLogSampling,
  });
  // Reached at its Custom Domain only (Cloudflare turns workers.dev on for a new account Worker).
  if (starter) await input.api.setWorkersDev(input.tenant.scriptName, false);
  return uploaded;
}
