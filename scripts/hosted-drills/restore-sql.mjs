// The restore drill's statements against the platform database
// (restore.mjs). Pure, so the platform's workerd tests run them against the
// real schema and the real provisioning (platform/test/drills.test.ts).
//
// The drill takes a tenant off the air through provisioning's own states:
// `db_created` with `provision_paused_at` set is a tenant the platform
// neither routes to (only `ready` tenants are) nor schedules (the due index
// holds only `ready` ones), and that the provisioning sweep leaves alone
// while it is paused. Unpausing it with a new database id makes the sweep
// upload it again exactly as at sign-up: the current bundle, bound to that
// database, with the escrowed MASTER_KEY; then migrate, health, `ready`.

import { sqlValue } from "./sql.mjs";

/** The tenant, its active escrowed key, and anything else working on it. */
export function tenantLookupSql(slug) {
  const id = `(SELECT id FROM tenants WHERE slug = ${sqlValue(slug)})`;
  return [
    `SELECT id, account_id, slug, d1_id, provision_state, status, owner_suspended_at, provision_paused_at, version FROM tenants WHERE slug = ${sqlValue(slug)}`,
    `SELECT kid, ciphertext FROM escrowed_keys WHERE tenant_id = ${id} AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    "SELECT COUNT(*) AS n FROM releases WHERE dry_run = 0 AND state IN ('canary', 'rolling', 'paused')",
    `SELECT COUNT(*) AS n FROM tenant_exports WHERE tenant_id = ${id} AND state IN ('requested', 'exporting')`,
  ].join("; ");
}

/** Off the air: only from `ready`, and marked with the drill's own time so only the drill puts it back. */
export function quiesceSql(tenantId, { at, note }) {
  return [
    `UPDATE tenants SET provision_state = 'db_created', provision_paused_at = ${sqlValue(at)}, provision_error = ${sqlValue(note)}, updated_at = ${sqlValue(at)} WHERE id = ${sqlValue(tenantId)} AND provision_state = 'ready' AND provision_paused_at IS NULL`,
    `SELECT provision_state, provision_paused_at FROM tenants WHERE id = ${sqlValue(tenantId)}`,
  ].join("; ");
}

/** Back on the air with its own database, when the drill stops before deleting it. */
export function unquiesceSql(tenantId, { quiescedAt, now }) {
  return `UPDATE tenants SET provision_state = 'ready', provision_paused_at = NULL, provision_error = NULL, updated_at = ${sqlValue(now)} WHERE id = ${sqlValue(tenantId)} AND provision_state = 'db_created' AND provision_paused_at = ${sqlValue(quiescedAt)}`;
}

/** The export a customer would ask for (lifecycle/exports.ts, requestExport), run by the lifecycle cron. */
export function exportRequestSql({ exportId, tenantId, accountId, slug, at }) {
  return `INSERT INTO tenant_exports (id, tenant_id, account_id, slug, reason, state, created_at, updated_at) VALUES (${[exportId, tenantId, accountId, slug, "self_host", "requested", at, at].map(sqlValue).join(", ")}) ON CONFLICT(id) DO NOTHING`;
}

export function exportStatusSql(exportId) {
  return `SELECT state, r2_prefix, bytes, sha256, error, attempts FROM tenant_exports WHERE id = ${sqlValue(exportId)}; SELECT kid, ciphertext FROM export_keys WHERE export_id = ${sqlValue(exportId)}`;
}

/** The new database, and the pause lifted: the sweep uploads the tenant again. */
export function rebindSql(tenantId, { d1Id, quiescedAt, now }) {
  return [
    `UPDATE tenants SET d1_id = ${sqlValue(d1Id)}, provision_paused_at = NULL, provision_attempts = 0, provision_next_at = NULL, provision_error = NULL, updated_at = ${sqlValue(now)} WHERE id = ${sqlValue(tenantId)} AND provision_state = 'db_created' AND provision_paused_at = ${sqlValue(quiescedAt)}`,
    `SELECT d1_id, provision_paused_at FROM tenants WHERE id = ${sqlValue(tenantId)}`,
  ].join("; ");
}
