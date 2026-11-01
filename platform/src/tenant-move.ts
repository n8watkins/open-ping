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
 *   3. record it as a dispatch tenant and delete its call secret, in one
 *      batch: from here the platform calls it through the namespace, and
 *      the starter Worker can't sign for it any more;
 *   4. move its Custom Domain to the platform Worker in place (one update,
 *      so the hostname never stops answering; repointTenantAddress);
 *   5. delete the old account Worker.
 *
 * Visitors are served throughout: by the starter Worker until step 4, by
 * the dispatched one after. Between steps 3 and 4 (one API call) the starter
 * Worker can't refresh its description, so it serves the one it has (up to
 * 10 minutes old) and only an isolate with none answers 503. Running it again after a failure picks up where
 * it stopped: a tenant already recorded as dispatch goes straight to steps 4
 * and 5. The region probes' Durable Object storage (short-lived re-check
 * state) starts empty in the new Worker.
 */

import { PLATFORM_HEALTH_PATH, type HealthResponse } from "../../src/shared/hosted-contract";
import { repointTenantAddress, tenantHostname } from "./addresses";
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
      // Its own recorded version: a move changes where it runs, never what it runs.
      if (!record.version || !deps.bundles.version) throw new PermanentError("its recorded release isn't available to upload again");
      const bundle = await deps.bundles.version(record.version);
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
      // One batch: from the moment it runs in the namespace, its secret is
      // gone, so the starter Worker left behind can never speak for it again.
      await deps.db.batch([
        deps.db
          .prepare("UPDATE tenants SET runtime = 'dispatch', version = ?, do_migration_tag = ?, do_migration_pending = NULL, updated_at = ? WHERE id = ? AND runtime = 'starter'")
          .bind(bundle.version, bundle.migrations.at(-1)?.tag ?? null, now, record.id),
        deps.db.prepare("DELETE FROM tenant_call_secrets WHERE tenant_id = ?").bind(record.id),
      ]);
      forgetCallKeys(record.id);
      forgetTenant(record.slug);
      version = bundle.version;
    }

    step = "address";
    // The same Custom Domain, moved to the platform Worker in place, so the
    // hostname never stops answering.
    const newDomainId = await repointTenantAddress(addressDeps(deps, now), asDispatch, loaded.customDomainId);
    await deps.db.prepare("UPDATE tenants SET custom_domain_id = ? WHERE id = ?").bind(newDomainId, record.id).run();

    step = "cleanup";
    await deps.api.deleteScript(null, record.scriptName);
    await audit(deps.db, record, "tenant.moved_to_dispatch", now, { version, hostname: tenantHostname(record.slug, deps.config.hostedDomain) });
    return { kind: "moved", tenantId, version };
  } catch (error) {
    const message = describeError(error);
    log.error("tenant.move_failed", { tenant: tenantId, step, error: message });
    return { kind: "failed", tenantId, step, error: message };
  }
}
