/**
 * What the admin console reads and changes in the platform database: the
 * tenant list with its filters, one tenant in full, the audit log, and
 * suspending and resuming. Provisioning's own changes (resume, remove) stay
 * in ../provisioning.ts.
 */

import { PLAN_IDS, TENANT_STATUSES, isTenantId, tenantDatabaseName, type PlanId, type PlanLimits, type TenantStatus } from "../../../src/shared/hosted-contract";
import { PROVISION_STATES, effectiveLimits, forgetTenant, tenantFromRow, type ProvisionState, type TenantRecord } from "../tenants";

export const TENANT_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE = 50;

/** The list's "setup" filter: a provisioning state, or every paused tenant whatever its state. */
export const SETUP_FILTERS = [...PROVISION_STATES, "paused"] as const;
export type SetupFilter = (typeof SETUP_FILTERS)[number];

export interface TenantFilters {
  q: string;
  status: TenantStatus | null;
  plan: PlanId | null;
  setup: SetupFilter | null;
  page: number;
}

function pick<T extends string>(values: readonly T[], value: string | undefined): T | null {
  return value && (values as readonly string[]).includes(value) ? (value as T) : null;
}

/** Filters from the query string; anything unknown is dropped, never an error. */
export function tenantFilters(query: Record<string, string | undefined>): TenantFilters {
  const page = Number.parseInt(query.page ?? "1", 10);
  return {
    q: (query.q ?? "").trim().slice(0, 100),
    status: pick(TENANT_STATUSES, query.status),
    plan: pick(PLAN_IDS, query.plan),
    setup: pick(SETUP_FILTERS, query.setup),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** A LIKE pattern matching `text` anywhere, with its own % and _ taken literally. */
export function containsPattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The status a tenant is routed by (TenantRecord.status): suspended while billing or the owner says so. */
const EFFECTIVE_STATUS = "(CASE WHEN t.owner_suspended_at IS NOT NULL THEN 'suspended' ELSE t.status END)";

export interface TenantListRow {
  id: string;
  slug: string;
  email: string;
  status: TenantStatus;
  plan: PlanId;
  provisionState: ProvisionState;
  paused: boolean;
  version: string | null;
  monitors: number | null;
  createdAt: number;
}

export interface TenantList {
  rows: TenantListRow[];
  total: number;
  filters: TenantFilters;
  pageSize: number;
}

export async function listTenants(db: D1Database, filters: TenantFilters): Promise<TenantList> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (filters.q) {
    const exactId = isTenantId(filters.q.toLowerCase()) ? filters.q.toLowerCase() : "";
    where.push("(t.slug LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR t.id = ? OR t.account_id = ?)");
    const pattern = containsPattern(filters.q);
    binds.push(pattern, pattern, exactId, filters.q);
  }
  if (filters.status) {
    where.push(`${EFFECTIVE_STATUS} = ?`);
    binds.push(filters.status);
  }
  if (filters.plan) {
    where.push("t.plan = ?");
    binds.push(filters.plan);
  }
  if (filters.setup === "paused") where.push("t.provision_paused_at IS NOT NULL");
  else if (filters.setup) {
    where.push("t.provision_state = ?");
    binds.push(filters.setup);
  }
  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const tenantsAndAccounts = "FROM tenants t JOIN accounts a ON a.id = t.account_id";
  const offset = (filters.page - 1) * TENANT_PAGE_SIZE;
  type Row = {
    id: string;
    slug: string;
    email: string;
    status: string;
    plan: string;
    provision_state: string;
    provision_paused_at: number | null;
    version: string | null;
    created_at: number;
    monitors: number | null;
  };
  const [total, rows] = await db.batch<unknown>([
    db.prepare(`SELECT COUNT(*) AS n ${tenantsAndAccounts}${filter}`).bind(...binds),
    db
      .prepare(
        `SELECT t.id, t.slug, a.email, ${EFFECTIVE_STATUS} AS status, t.plan, t.provision_state, t.provision_paused_at, t.version, t.created_at, u.monitors
         ${tenantsAndAccounts} LEFT JOIN tenant_usage u ON u.tenant_id = t.id${filter}
         ORDER BY t.created_at DESC, t.id LIMIT ? OFFSET ?`,
      )
      .bind(...binds, TENANT_PAGE_SIZE, offset),
  ]);
  return {
    total: (total!.results[0] as { n: number } | undefined)?.n ?? 0,
    pageSize: TENANT_PAGE_SIZE,
    filters,
    rows: (rows!.results as Row[]).map((r) => ({
      id: r.id,
      slug: r.slug,
      email: r.email,
      // The CHECK constraints make these exact; the fallbacks match tenantFromRow's.
      status: pick(TENANT_STATUSES, r.status) ?? "suspended",
      plan: pick(PLAN_IDS, r.plan) ?? "trial",
      provisionState: pick(PROVISION_STATES, r.provision_state) ?? "requested",
      paused: r.provision_paused_at !== null,
      version: r.version,
      monitors: r.monitors,
      createdAt: r.created_at,
    })),
  };
}

export interface TenantCounts {
  all: number;
  settingUp: number;
  paused: number;
  suspended: number;
}

/** The numbers above the list: one query over the whole table. */
export async function tenantCounts(db: D1Database): Promise<TenantCounts> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS all_count,
              COALESCE(SUM(provision_state <> 'ready' AND provision_state <> 'deleting' AND provision_paused_at IS NULL), 0) AS setting_up,
              COALESCE(SUM(provision_paused_at IS NOT NULL), 0) AS paused,
              COALESCE(SUM(status = 'suspended' OR owner_suspended_at IS NOT NULL), 0) AS suspended
       FROM tenants`,
    )
    .first<{ all_count: number; setting_up: number; paused: number; suspended: number }>();
  return { all: row?.all_count ?? 0, settingUp: row?.setting_up ?? 0, paused: row?.paused ?? 0, suspended: row?.suspended ?? 0 };
}

export interface TenantDetail {
  record: TenantRecord;
  email: string;
  accountDisabled: boolean;
  /** When the account's deletion was asked for (src/account-deletion.ts), or null. */
  accountDeletionAt: number | null;
  databaseName: string;
  d1Id: string | null;
  limits: PlanLimits;
  createdAt: number;
  updatedAt: number;
  provisionedAt: number | null;
  /** Billing's suspension (B5), when tenants.status is suspended. */
  billingSuspendedAt: number | null;
  /** The owner's suspension from this console, or null. */
  ownerSuspension: { at: number; reason: string | null } | null;
  provision: {
    attempts: number;
    error: string | null;
    nextAt: number | null;
    pausedAt: number | null;
    leaseUntil: number | null;
  };
  usage: { monitors: number; statusPages: number; channels: number; countedAt: number; reportedAt: number } | null;
}

export async function tenantDetail(db: D1Database, tenantId: string): Promise<TenantDetail | null> {
  if (!isTenantId(tenantId)) return null;
  const row = await db
    .prepare(
      `SELECT t.id, t.account_id, t.slug, t.script_name, t.status, t.plan, t.provision_state, t.version, t.limit_overrides,
              t.trial_ends_at, t.d1_id, t.created_at, t.updated_at, t.provisioned_at, t.suspended_at, t.owner_suspended_at,
              t.owner_suspended_reason, t.provision_attempts, t.provision_error, t.provision_next_at, t.provision_paused_at,
              t.provision_lease_until, a.email, a.disabled_at, a.deletion_requested_at,
              u.monitors, u.status_pages, u.channels, u.counted_at, u.reported_at
       FROM tenants t JOIN accounts a ON a.id = t.account_id LEFT JOIN tenant_usage u ON u.tenant_id = t.id
       WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<{
      id: string;
      account_id: string;
      slug: string;
      script_name: string;
      status: string;
      plan: string;
      provision_state: string;
      version: string | null;
      limit_overrides: string | null;
      trial_ends_at: number | null;
      d1_id: string | null;
      created_at: number;
      updated_at: number;
      provisioned_at: number | null;
      suspended_at: number | null;
      owner_suspended_at: number | null;
      owner_suspended_reason: string | null;
      provision_attempts: number;
      provision_error: string | null;
      provision_next_at: number | null;
      provision_paused_at: number | null;
      provision_lease_until: number | null;
      email: string;
      disabled_at: number | null;
      deletion_requested_at: number | null;
      monitors: number | null;
      status_pages: number | null;
      channels: number | null;
      counted_at: number | null;
      reported_at: number | null;
    }>();
  if (!row) return null;
  const record = tenantFromRow(row);
  return {
    record,
    email: row.email,
    accountDisabled: row.disabled_at !== null,
    accountDeletionAt: row.deletion_requested_at,
    databaseName: tenantDatabaseName(row.id),
    d1Id: row.d1_id,
    limits: effectiveLimits(record),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provisionedAt: row.provisioned_at,
    billingSuspendedAt: record.billingStatus === "suspended" ? row.suspended_at : null,
    ownerSuspension: row.owner_suspended_at === null ? null : { at: row.owner_suspended_at, reason: row.owner_suspended_reason },
    provision: {
      attempts: row.provision_attempts,
      error: row.provision_error,
      nextAt: row.provision_next_at,
      pausedAt: row.provision_paused_at,
      leaseUntil: row.provision_lease_until,
    },
    usage:
      row.monitors === null
        ? null
        : {
            monitors: row.monitors,
            statusPages: row.status_pages!,
            channels: row.channels!,
            // The tenant's own clock orders its reports; what is shown is never later than when it arrived.
            countedAt: Math.min(row.counted_at!, row.reported_at!),
            reportedAt: row.reported_at!,
          },
  };
}

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

export const AUDIT_ACTOR_FILTERS = ["customer", "support", "system", "owner"] as const;
export type AuditActor = (typeof AUDIT_ACTOR_FILTERS)[number];

export interface AuditEvent {
  id: number;
  at: number;
  accountId: string | null;
  email: string | null;
  tenantId: string | null;
  slug: string | null;
  actor: AuditActor;
  action: string;
  detail: Record<string, unknown> | null;
}

export interface AuditFilters {
  tenant: string;
  actor: AuditActor | null;
  action: string;
  /** Only events with a smaller id: the "older" page. */
  before: number | null;
}

export function auditFilters(query: Record<string, string | undefined>): AuditFilters {
  const before = Number.parseInt(query.before ?? "", 10);
  return {
    tenant: (query.tenant ?? "").trim().toLowerCase().slice(0, 64),
    actor: pick(AUDIT_ACTOR_FILTERS, query.actor),
    action: (query.action ?? "").trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 64),
    before: Number.isSafeInteger(before) && before > 0 ? before : null,
  };
}

/** The smallest string greater than every string starting with `prefix` (its last character, plus one). */
export function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function parseDetail(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type AuditRow = {
  id: number;
  at: number;
  account_id: string | null;
  email: string | null;
  tenant_id: string | null;
  slug: string | null;
  actor: string;
  action: string;
  detail: string | null;
};

const AUDIT_SELECT = `SELECT e.id, e.at, e.account_id, a.email, e.tenant_id, t.slug, e.actor, e.action, e.detail
  FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN tenants t ON t.id = e.tenant_id`;

function auditFromRow(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    at: r.at,
    accountId: r.account_id,
    email: r.email,
    tenantId: r.tenant_id,
    slug: r.slug,
    actor: pick(AUDIT_ACTOR_FILTERS, r.actor) ?? "system",
    action: r.action,
    detail: parseDetail(r.detail),
  };
}

/** The audit page's query: newest first, one row more than a page (to know there is another). */
export function auditLogQuery(filters: AuditFilters): { sql: string; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (filters.tenant) {
    // A tenant id, or the slug of one that still exists.
    where.push("(e.tenant_id = ? OR e.tenant_id IN (SELECT id FROM tenants WHERE slug = ?))");
    binds.push(filters.tenant, filters.tenant);
  }
  if (filters.actor) {
    where.push("e.actor = ?");
    binds.push(filters.actor);
  }
  if (filters.action) {
    // A prefix ("tenant." finds every tenant event), as a range so it can use
    // idx_audit_events_action; LIKE can't, with SQLite's case-insensitive LIKE.
    where.push("e.action >= ? AND e.action < ?");
    binds.push(filters.action, prefixUpperBound(filters.action));
  }
  if (filters.before) {
    where.push("e.id < ?");
    binds.push(filters.before);
  }
  return { sql: `${AUDIT_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`, binds: [...binds, AUDIT_PAGE_SIZE + 1] };
}

/** Newest first, one page; `more` when there is an older page. */
export async function auditLog(db: D1Database, filters: AuditFilters): Promise<{ events: AuditEvent[]; more: boolean }> {
  const query = auditLogQuery(filters);
  const rows = await db.prepare(query.sql).bind(...query.binds).all<AuditRow>();
  const events = rows.results.slice(0, AUDIT_PAGE_SIZE).map(auditFromRow);
  return { events, more: rows.results.length > AUDIT_PAGE_SIZE };
}

/** One tenant's history, newest first: provisioning, sign-ins, the owner's actions. */
export async function tenantHistory(db: D1Database, tenantId: string, limit = 30): Promise<AuditEvent[]> {
  const rows = await db.prepare(`${AUDIT_SELECT} WHERE e.tenant_id = ? ORDER BY e.id DESC LIMIT ?`).bind(tenantId, limit).all<AuditRow>();
  return rows.results.map(auditFromRow);
}

/** Support sign-ins to a customer's OpenPing, for their own account page. */
export async function supportSignIns(db: D1Database, tenantId: string, limit = 10): Promise<{ at: number; reason: string | null }[]> {
  const rows = await db
    .prepare("SELECT at, detail FROM audit_events WHERE tenant_id = ? AND action = 'support.handoff_issued' ORDER BY id DESC LIMIT ?")
    .bind(tenantId, limit)
    .all<{ at: number; detail: string | null }>();
  return rows.results.map((r) => {
    const reason = parseDetail(r.detail)?.reason;
    return { at: r.at, reason: typeof reason === "string" ? reason : null };
  });
}

// ---------------------------------------------------------------------------
// Suspending and resuming
// ---------------------------------------------------------------------------

/** What the owner writes when suspending, or for a support sign-in: short, one line. */
export const REASON_MAX_LENGTH = 200;

/** A reason as stored: printable characters only, trimmed, at most REASON_MAX_LENGTH. */
export function cleanReason(input: unknown): string {
  if (typeof input !== "string") return "";
  return [...input]
    .map((ch) => (ch < " " || ch === "\u007f" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_MAX_LENGTH);
}

/**
 * The owner suspends a tenant (abuse, the terms). Only the owner's columns
 * change, never billing's `status`, so billing can't lift it and lifting it
 * leaves billing as it was. Routing stops at once in this isolate
 * (forgetTenant) and within TENANT_CACHE_MS (30 seconds) everywhere else.
 * False when the owner had already suspended it or it is being removed.
 */
export async function suspendTenant(db: D1Database, tenant: Pick<TenantRecord, "id" | "slug">, reason: string, now: number): Promise<boolean> {
  const changed = await db
    .prepare(
      `UPDATE tenants SET owner_suspended_at = ?, owner_suspended_reason = ?, updated_at = ?
       WHERE id = ? AND owner_suspended_at IS NULL AND provision_state <> 'deleting'`,
    )
    .bind(now, reason, now, tenant.id)
    .run();
  forgetTenant(tenant.slug);
  return (changed.meta.changes ?? 0) > 0;
}

/**
 * Lifts the owner's suspension; billing's state is whatever billing says.
 * Answers that state (still `suspended` when billing suspended it too), or
 * null when the owner hadn't suspended it.
 */
export async function resumeTenant(db: D1Database, tenant: Pick<TenantRecord, "id" | "slug">, now: number): Promise<TenantStatus | null> {
  const row = await db
    .prepare(
      `UPDATE tenants SET owner_suspended_at = NULL, owner_suspended_reason = NULL, updated_at = ?
       WHERE id = ? AND owner_suspended_at IS NOT NULL RETURNING status`,
    )
    .bind(now, tenant.id)
    .first<{ status: string }>();
  forgetTenant(tenant.slug);
  return row ? (pick(TENANT_STATUSES, row.status) ?? "suspended") : null;
}
