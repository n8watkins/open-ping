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

import { HOSTED_ENV, HOSTED_MODE_ON, STARTER_ENV, STARTER_TRANSPORT_ON, generatePlatformCallSecret } from "../../src/shared/hosted-contract";
import { DISPATCH_LIMITS } from "./dispatch";
import { PermanentError } from "./errors";
import { log } from "./log";
import type { TenantBundle } from "./bundle";
import type { CloudflareApi, ScriptLocation, UploadedScript } from "./cloudflare/api";
import { uploadUserWorker } from "./cloudflare/upload";
import { appOrigin } from "./hosts";
import { activeEscrowedKey, ensureCallSecret, openEscrowedKey, sealCallSecret } from "./keys";
import { describeError, type ProvisioningConfig, type ProvisioningDeps } from "./provisioning";
import { forgetCallKeys } from "./starter";
import { TENANT_COLUMNS, tenantFromRow, type TenantRecord, type TenantRow, type TenantRuntime } from "./tenants";

/**
 * A starter Worker's per-invocation caps. Dispatch sets them per call (a
 * visitor's request 1 s of CPU and 200 subrequests, a platform call 15 s and
 * 1,000); an ordinary Worker has one set for every invocation, so it gets the
 * platform call's, which its scheduled runs need. A visitor's request to a
 * starter tenant is held to those, not the tighter public ones.
 */
export const STARTER_LIMITS = { cpu_ms: DISPATCH_LIMITS.platform.cpuMs, subrequests: DISPATCH_LIMITS.platform.subRequests } as const;

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
  /** A starter tenant's secret to set instead of its stored one (a rotation's next one). */
  callSecret?: string;
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
  if (starter) secrets[STARTER_ENV.callSecret] = input.callSecret ?? (await ensureCallSecret(input.db, input.tenant.id, input.config.platformKey, input.now));
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
    ...(starter ? { limits: { ...STARTER_LIMITS } } : {}),
  });
  // Reached at its Custom Domain only (Cloudflare turns workers.dev on for a new account Worker).
  if (starter) await input.api.setWorkersDev(input.tenant.scriptName, false);
  return uploaded;
}

export type RotateOutcome = { kind: "rotated"; tenantId: string } | { kind: "refused"; tenantId: string; reason: string } | { kind: "failed"; tenantId: string; error: string };

/**
 * Gives a ready starter tenant a new PLATFORM_CALL_SECRET (the admin
 * console's "Rotate its call secret", or after a suspected leak):
 *
 *   1. the new one is sealed beside the current one (next_ciphertext), and
 *      from then on the platform accepts either;
 *   2. the tenant's Worker is uploaded again on its own recorded version
 *      with the new one;
 *   3. the new one replaces the current one, which is never accepted again.
 *
 * Between 2 and 3 (one database write) a platform call is still signed with
 * the old secret and refused by the Worker, and the scheduler simply calls
 * again on the next tick. Other isolates of the platform keep a tenant's keys
 * for CALL_KEYS_CACHE_MS, so the old secret is accepted that much longer.
 * A rotation that fails partway leaves both accepted; running it again
 * replaces the waiting one.
 */
export async function rotateCallSecret(deps: ProvisioningDeps, tenantId: string): Promise<RotateOutcome> {
  const now = (deps.now ?? Date.now)();
  const row = await deps.db
    .prepare(`SELECT ${TENANT_COLUMNS}, d1_id, do_migration_tag FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<TenantRow & { d1_id: string | null; do_migration_tag: string | null }>();
  if (!row) return { kind: "refused", tenantId, reason: "There is no such tenant." };
  const tenant = tenantFromRow(row);
  if (tenant.runtime !== "starter" || tenant.provisionState !== "ready") return { kind: "refused", tenantId, reason: "Only a ready starter tenant has a call secret to rotate." };
  if (!row.d1_id || !tenant.version || !deps.bundles.version) return { kind: "refused", tenantId, reason: "Its database or its release isn't recorded." };
  try {
    const escrowed = await activeEscrowedKey(deps.db, tenant.id);
    if (!escrowed) throw new PermanentError("it has no escrowed MASTER_KEY");
    const masterKey = await openEscrowedKey(escrowed, tenant.id, deps.config.platformKey);
    const bundle = await deps.bundles.version(tenant.version);
    const next = generatePlatformCallSecret();
    const sealed = await sealCallSecret(next, tenant.id, deps.config.platformKey);
    await deps.db.prepare("UPDATE tenant_call_secrets SET next_ciphertext = ? WHERE tenant_id = ?").bind(sealed, tenant.id).run();
    forgetCallKeys(tenant.id);
    await uploadTenant({ db: deps.db, api: deps.api, config: deps.config, tenant, bundle, d1Id: row.d1_id, masterKey, previousMigrationTag: row.do_migration_tag, now, callSecret: next });
    await deps.db
      .prepare("UPDATE tenant_call_secrets SET ciphertext = next_ciphertext, next_ciphertext = NULL WHERE tenant_id = ? AND next_ciphertext = ?")
      .bind(tenant.id, sealed)
      .run();
    forgetCallKeys(tenant.id);
    log.info("tenant.call_secret_rotated", { tenant: tenant.id });
    await deps.db
      .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', 'tenant.call_secret_rotated', NULL)")
      .bind(now, tenant.accountId, tenant.id)
      .run();
    return { kind: "rotated", tenantId };
  } catch (error) {
    log.error("tenant.call_secret_rotation_failed", { tenant: tenant.id, error });
    return { kind: "failed", tenantId, error: describeError(error) };
  }
}
