// The load test's tenants and their monitors, as SQL (docs/hosted/LAUNCH_DRILLS.md).
//
// Pure: no Node imports, so the platform's and OpenPing's workerd tests run
// exactly this SQL against the real schemas (platform/test/drills.test.ts,
// test/integration/hosted-drills.test.ts).
//
// A load-test tenant is an ordinary tenant row in the staging platform
// database, in state `requested`: the platform's own provisioning (the
// every-minute sweep, platform/src/provisioning.ts) generates and escrows its
// MASTER_KEY, creates its database, uploads the current bundle and waits for
// its health, exactly as for a sign-up. What marks it as the load test's:
//
//   - its account's email is lt-<run>-<n>@loadtest.invalid, which no mail
//     provider delivers to;
//   - its slug is lt-<run>-<nnn>;
//   - it is on the paid plan (`active`, `hosted`, no Stripe subscription), so
//     20 monitors fit and no trial email or trial end applies;
//   - its welcome email is recorded as already sent, so none goes out.

import { sqlValue } from "./sql.mjs";

export const LOAD_EMAIL_DOMAIN = "loadtest.invalid";
export const LOAD_SLUG_PREFIX = "lt-";
/** Each load-test tenant gets this plan: 20 monitors at 12-minute checks. */
export const LOAD_PLAN = "hosted";
export const LOAD_INTERVAL_SECONDS = 720;

const RUN_PATTERN = /^[a-z0-9]{4}$/;
const TENANT_ID_PATTERN = /^[a-z0-9]{16}$/;

export function isRunId(value) {
  return typeof value === "string" && RUN_PATTERN.test(value);
}

/** The tenants of a run: ids made here, so later steps can find them without asking. */
export function loadTenants({ runId, count, newTenantId }) {
  if (!isRunId(runId)) throw new Error("a run id is 4 characters of [a-z0-9]");
  if (!Number.isSafeInteger(count) || count < 1 || count > 999) throw new Error("1 to 999 tenants");
  const tenants = [];
  const ids = new Set();
  for (let n = 1; n <= count; n++) {
    const tenantId = newTenantId();
    if (!TENANT_ID_PATTERN.test(tenantId) || ids.has(tenantId)) throw new Error("tenant ids must be unique and 16 characters of [a-z0-9]");
    ids.add(tenantId);
    const nnn = String(n).padStart(3, "0");
    tenants.push({ tenantId, accountId: `acc_lt${runId}${nnn}`, slug: `${LOAD_SLUG_PREFIX}${runId}-${nnn}`, email: `lt-${runId}-${nnn}@${LOAD_EMAIL_DOMAIN}` });
  }
  return tenants;
}

/** The statements that create the run's accounts and tenants in the platform database. */
export function platformSeedSql(tenants, { now }) {
  const lines = [];
  for (const t of tenants) {
    lines.push(`INSERT INTO accounts (id, email, name, created_at, updated_at) VALUES (${[t.accountId, t.email, `Load test ${t.slug}`, now, now].map(sqlValue).join(", ")});`);
    lines.push(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, created_at, updated_at) VALUES (${[t.tenantId, t.accountId, t.slug, `t-${t.tenantId}`, "active", LOAD_PLAN, "requested", now, now].map(sqlValue).join(", ")});`,
    );
    // The welcome email, already "sent": the lifecycle job sends each notice once (platform/src/lifecycle/jobs.ts).
    lines.push(`INSERT INTO lifecycle_notices (tenant_id, kind, cycle, state, claimed_at, sent_at) VALUES (${[t.tenantId, "welcome", "once", "sent", now, now].map(sqlValue).join(", ")});`);
  }
  return lines.join("\n") + "\n";
}

/** The WHERE that picks the load test's tenants (all runs, or one). */
export function loadTenantFilter(runId = null, alias = "") {
  if (runId !== null && !isRunId(runId)) throw new Error("a run id is 4 characters of [a-z0-9]");
  const slug = runId ? `${LOAD_SLUG_PREFIX}${runId}-%` : `${LOAD_SLUG_PREFIX}%`;
  const t = alias ? `${alias}.` : "";
  return `${t}slug LIKE ${sqlValue(slug)} AND ${t}account_id IN (SELECT id FROM accounts WHERE email LIKE ${sqlValue(`%@${LOAD_EMAIL_DOMAIN}`)})`;
}

/** How far the run's tenants got: counts by state, and the paused ones with their errors. */
export function provisionStatusSql(runId) {
  return [
    `SELECT provision_state AS state, provision_paused_at IS NOT NULL AS paused, COUNT(*) AS n FROM tenants WHERE ${loadTenantFilter(runId)} GROUP BY 1, 2`,
    `SELECT slug, provision_state AS state, provision_error AS error FROM tenants WHERE ${loadTenantFilter(runId)} AND provision_paused_at IS NOT NULL ORDER BY slug LIMIT 20`,
  ].join("; ");
}

/** Each ready tenant's database and active escrowed key, for seeding its monitors. */
export function seedKeysSql(runId) {
  return `SELECT t.id AS tenant_id, t.slug, t.d1_id, k.kid, k.ciphertext FROM tenants t JOIN escrowed_keys k ON k.tenant_id = t.id AND k.retired_at IS NULL WHERE ${loadTenantFilter(runId, "t")} AND t.provision_state = 'ready' ORDER BY t.slug`;
}

/**
 * What the run's monitors point at, by position: most answer at once, and a
 * few fail on a schedule, so the run exercises failures, the confirm
 * re-check, incidents opening and resolving, and a slow answer. The echo
 * Worker (echo-worker/index.js) implements each path.
 */
export function monitorTargets(echoUrl, count) {
  const base = echoUrl.replace(/\/+$/, "");
  const targets = [];
  for (let i = 0; i < count; i++) {
    const slot = i % 20;
    if (slot === 17) targets.push({ name: "Flaky (10% of checks fail)", url: `${base}/flaky?rate=10&m=${i}` });
    else if (slot === 18) targets.push({ name: "Slow (1.5 s)", url: `${base}/slow?ms=1500` });
    else if (slot === 19) targets.push({ name: "Down from :20 to :29", url: `${base}/window?down=20-29` });
    else targets.push({ name: `Echo ${String(i + 1).padStart(2, "0")}`, url: `${base}/ok?m=${i}` });
  }
  return targets;
}

/**
 * The config document createMonitor stores for an HTTP monitor, before
 * sealing: the schema's defaults filled in (src/shared/schemas.ts,
 * httpConfigSchema). test/integration/hosted-drills.test.ts checks it is
 * exactly what `createMonitorSchema.parse` makes of `{ url }`.
 */
export function httpConfig(url) {
  return { url, method: "GET", headers: [], auth: { type: "none" }, timeoutMs: 60000, warmupTimeoutMs: 120000, followRedirects: true, expectedStatus: { min: 200, max: 399 } };
}

/** The other columns createMonitor writes for that monitor (the schema's defaults). */
export const MONITOR_DEFAULTS = {
  schedule: { mode: "always" },
  assertions: [],
  notify: { channels: [] },
  public: { visible: false, sortOrder: 0, showUptime: true, showResponseTime: false, showIncidentDetails: true },
  confirmFailures: "retry",
};

/**
 * The statements that add a tenant's monitors, as createMonitor does (a
 * monitors row with its config sealed under the tenant's MASTER_KEY, and its
 * monitor_state row). `seal` is keys.mjs's sealConfig bound to the key.
 */
export async function monitorSeedSql({ targets, seal, now, newMonitorId }) {
  const lines = [];
  for (const target of targets) {
    const id = newMonitorId();
    const config = await seal(httpConfig(target.url));
    const values = [
      id,
      "http",
      target.name,
      1,
      0,
      LOAD_INTERVAL_SECONDS,
      null,
      MONITOR_DEFAULTS.confirmFailures,
      JSON.stringify(config),
      JSON.stringify(MONITOR_DEFAULTS.schedule),
      JSON.stringify(MONITOR_DEFAULTS.assertions),
      JSON.stringify(MONITOR_DEFAULTS.notify),
      JSON.stringify(MONITOR_DEFAULTS.public),
      null,
      null,
      null,
      0,
      now,
      now,
    ];
    lines.push(
      `INSERT INTO monitors (id, type, name, enabled, paused, interval_seconds, grace_seconds, confirm_failures, config, schedule, assertions, notify, public, category_id, heartbeat_token, heartbeat_token_hash, sort_order, created_at, updated_at) VALUES (${values.map(sqlValue).join(", ")});`,
    );
    lines.push(
      `INSERT INTO monitor_state (monitor_id, state, state_since, consecutive_failures, consecutive_successes, next_check_at, updated_at) VALUES (${[id, "unknown", now, 0, 0, now, now].map(sqlValue).join(", ")});`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Cleanup, first half: every load-test tenant of the run marked for
 * removal, as markForRemoval does (platform/src/provisioning.ts); the
 * platform's sweep then tears each one down (script, database, key, row).
 */
export function markForRemovalSql(runId, { now }) {
  return `UPDATE tenants SET provision_state = 'deleting', provision_attempts = 0, provision_error = NULL, provision_next_at = NULL, provision_paused_at = NULL, updated_at = ${sqlValue(now)} WHERE ${loadTenantFilter(runId)}`;
}

export function remainingTenantsSql(runId) {
  return `SELECT COUNT(*) AS n FROM tenants WHERE ${loadTenantFilter(runId)}`;
}

/**
 * Cleanup, second half, once no tenant of the run is left: the rows the
 * teardown keeps on purpose (held slugs, history) and the accounts.
 */
export function leftoversSql(runId, tenantIds) {
  if (!isRunId(runId)) throw new Error("a run id is 4 characters of [a-z0-9]");
  const ids = tenantIds.filter((id) => TENANT_ID_PATTERN.test(id));
  const inIds = ids.length ? `(${ids.map(sqlValue).join(", ")})` : "(NULL)";
  const accounts = `SELECT id FROM accounts WHERE id LIKE ${sqlValue(`acc_lt${runId}%`)} AND email LIKE ${sqlValue(`%@${LOAD_EMAIL_DOMAIN}`)}`;
  return [
    `DELETE FROM slug_holds WHERE slug LIKE ${sqlValue(`${LOAD_SLUG_PREFIX}${runId}-%`)}`,
    ...["lifecycle_notices", "audit_events", "scheduler_days", "scheduler_stats", "tenant_usage", "tenant_email_usage", "email_recipients", "release_tenants"].map(
      (table) => `DELETE FROM ${table} WHERE tenant_id IN ${inIds}`,
    ),
    `DELETE FROM account_identities WHERE account_id IN (${accounts})`,
    `DELETE FROM accounts WHERE id IN (${accounts}) AND id NOT IN (SELECT account_id FROM tenants)`,
  ].join(";\n") + ";\n";
}
