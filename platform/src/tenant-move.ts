/**
 * Moving a starter tenant to Workers for Platforms (docs/hosted/CONTRACT.md,
 * section 10, "What stays the same"; platform/README.md, "Starter mode").
 *
 * The tenant's database, keys and data stay exactly where they are; only its
 * Worker moves, from an ordinary Worker t-<id> on the account into the
 * dispatch namespace, and its address follows. One tenant at a time, so the
 * fleet can move gradually (tenants.runtime is per tenant):
 *
 *   1. upload the current release into the namespace, as a dispatch tenant
 *      (no HOSTED_TRANSPORT, no PLATFORM_URL, no call secret);
 *   2. call its health through the namespace: it must answer ok on that
 *      version, or nothing else changes and the starter Worker keeps serving;
 *   3. record it as a dispatch tenant: from here the platform calls it
 *      through the namespace;
 *   4. point its Custom Domain at the platform Worker (custom_domains
 *      addresses), or detach it (the domain moved to a wildcard route);
 *   5. delete the old account Worker and its call secret.
 *
 * Visitors are served throughout: by the starter Worker until step 4, by
 * the dispatched one after. Running it again after a failure picks up where
 * it stopped: a tenant already recorded as dispatch goes straight to steps 4
 * and 5. The region probes' Durable Object storage (short-lived re-check
 * state) starts empty in the new Worker.
 */

import { PLATFORM_HEALTH_PATH, type HealthResponse } from "../../src/shared/hosted-contract";
import { tenantHostname, removeTenantAddress, ensureTenantAddress } from "./addresses";
import { callTenant } from "./dispatch";
import { PermanentError } from "./errors";
import { activeEscrowedKey, openEscrowedKey } from "./keys";
import { addressDeps, describeError, type ProvisioningDeps } from "./provisioning";
import { forgetCallKeys } from "./starter";
import { uploadTenant } from "./tenant-upload";
import { TENANT_COLUMNS, forgetTenant, tenantFromRow, type TenantRecord, type TenantRow } from "./tenants";
import { log } from "./log";

export type MoveOutcome =
  | { kind: "moved"; tenantId: string; version: string }
  | { kind: "refused"; tenantId: string; reason: string }
  | { kind: "failed"; tenantId: string; step: string; error: string };

interface MoveRow extends TenantRow {
  d1_id: string | null;
  custom_domain_id: string | null;
}

async function load(db: D1Database, tenantId: string): Promise<{ record: TenantRecord; d1Id: string | null; customDomainId: string | null } | null> {
  const row = await db.prepare(`SELECT ${TENANT_COLUMNS}, d1_id, custom_domain_id FROM tenants WHERE id = ?`).bind(tenantId).first<MoveRow>();
  return row ? { record: tenantFromRow(row), d1Id: row.d1_id, customDomainId: row.custom_domain_id } : null;
}

async function audit(db: D1Database, tenant: TenantRecord, action: string, now: number, detail: Record<string, unknown>): Promise<void> {
  log.info(action, { tenant: tenant.id, ...detail });
  await db
    .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, 'system', ?, ?)")
    .bind(now, tenant.accountId, tenant.id, action, JSON.stringify(detail))
    .run();
}

/** Moves one ready starter tenant into the dispatch namespace (the steps at the top of this file). */
export async function moveTenantToDispatch(deps: ProvisioningDeps, tenantId: string): Promise<MoveOutcome> {
  const now = (deps.now ?? Date.now)();
  const loaded = await load(deps.db, tenantId);
  if (!loaded) return { kind: "refused", tenantId, reason: "There is no such tenant." };
  const { record, d1Id } = loaded;
  if (record.provisionState !== "ready") return { kind: "refused", tenantId, reason: `It is ${record.provisionState}, not ready.` };
  if (!deps.config.namespace) return { kind: "refused", tenantId, reason: "DISPATCH_NAMESPACE isn't set: Workers for Platforms has to be on first." };
  const asDispatch: TenantRecord = { ...record, runtime: "dispatch" };
  let step = "upload";
  try {
    let version = record.version ?? "";
    if (record.runtime === "starter") {
      if (!d1Id) throw new PermanentError("it has no database id");
      const escrowed = await activeEscrowedKey(deps.db, record.id);
      if (!escrowed) throw new PermanentError("it has no escrowed MASTER_KEY");
      const masterKey = await openEscrowedKey(escrowed, record.id, deps.config.platformKey);
      const bundle = await deps.bundles.current();
      // A clean script in the namespace, whatever an earlier try left there.
      await deps.api.deleteScript(deps.config.namespace, record.scriptName);
      await uploadTenant({ db: deps.db, api: deps.api, config: deps.config, tenant: asDispatch, bundle, d1Id, masterKey, previousMigrationTag: null, now });

      step = "health";
      const result = await callTenant(deps.dispatcher, { tenant: asDispatch, hostedDomain: deps.config.hostedDomain, platform: deps.capability(asDispatch) }, PLATFORM_HEALTH_PATH);
      if (result.kind === "missing") throw new Error("the uploaded Worker isn't in the namespace");
      const health = await result.response.json<HealthResponse>().catch(() => null);
      if (!health?.ok || health.version !== bundle.version) {
        throw new Error(`health answered ${result.response.status}${health ? ` (ok ${String(health.ok)}, version ${health.version})` : ""}`);
      }

      step = "record";
      await deps.db
        .prepare("UPDATE tenants SET runtime = 'dispatch', version = ?, do_migration_tag = ?, do_migration_pending = NULL, updated_at = ? WHERE id = ? AND runtime = 'starter'")
        .bind(bundle.version, bundle.migrations.at(-1)?.tag ?? null, now, record.id)
        .run();
      forgetTenant(record.slug);
      version = bundle.version;
    }

    step = "address";
    const addresses = addressDeps(deps, now);
    // The starter Worker's own Custom Domain: by its recorded id while the
    // tenant was still a starter one; on a second try, found by hostname,
    // and then only if it still routes to the starter Worker.
    await removeTenantAddress(addresses, { ...record, runtime: "starter" }, record.runtime === "starter" ? loaded.customDomainId : null);
    const newDomainId = await ensureTenantAddress(addresses, asDispatch);
    await deps.db.prepare("UPDATE tenants SET custom_domain_id = ? WHERE id = ?").bind(newDomainId, record.id).run();

    step = "cleanup";
    await deps.api.deleteScript(null, record.scriptName);
    await deps.db.prepare("DELETE FROM tenant_call_secrets WHERE tenant_id = ?").bind(record.id).run();
    forgetCallKeys(record.id);
    await audit(deps.db, record, "tenant.moved_to_dispatch", now, { version, hostname: tenantHostname(record.slug, deps.config.hostedDomain) });
    return { kind: "moved", tenantId, version };
  } catch (error) {
    const message = describeError(error);
    log.error("tenant.move_failed", { tenant: tenantId, step, error: message });
    return { kind: "failed", tenantId, step, error: message };
  }
}
