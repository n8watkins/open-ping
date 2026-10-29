/**
 * Reading tenants from the platform database, and turning a row into what the
 * contract hands a customer's OpenPing (TenantInfo).
 */

import {
  PLAN_IDS,
  PLAN_LIMITS,
  TENANT_STATUSES,
  type HostedUrls,
  type PlanId,
  type PlanLimits,
  type TenantInfo,
  type TenantStatus,
} from "../../src/shared/hosted-contract";
import { CHANNEL_KINDS } from "../../src/shared/notifications";
import { appOrigin } from "./hosts";

export const PROVISION_STATES = ["requested", "db_created", "uploaded", "migrated", "ready", "deleting"] as const;
export type ProvisionState = (typeof PROVISION_STATES)[number];

export interface TenantRecord {
  id: string;
  accountId: string;
  slug: string;
  scriptName: string;
  /**
   * What the tenant is told and routed by: `suspended` while billing or the
   * owner says so, otherwise billing's state.
   */
  status: TenantStatus;
  /** Billing's state alone (tenants.status), which only billing changes. */
  billingStatus: TenantStatus;
  /** When the owner suspended it (admin console), or null. */
  ownerSuspendedAt: number | null;
  plan: PlanId;
  provisionState: ProvisionState;
  version: string | null;
  limitOverrides: Partial<PlanLimits> | null;
  trialEndsAt: number | null;
}

export interface TenantRow {
  id: string;
  account_id: string;
  slug: string;
  script_name: string;
  status: string;
  owner_suspended_at: number | null;
  plan: string;
  provision_state: string;
  version: string | null;
  limit_overrides: string | null;
  trial_ends_at: number | null;
}

export const TENANT_COLUMNS =
  "id, account_id, slug, script_name, status, owner_suspended_at, plan, provision_state, version, limit_overrides, trial_ends_at";

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Only the known PlanLimits keys with the right types; anything else in the JSON is ignored. */
export function parseLimitOverrides(json: string | null): Partial<PlanLimits> | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<PlanLimits> = {};
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (count(r.monitors)) out.monitors = r.monitors as number;
  if (count(r.statusPages)) out.statusPages = r.statusPages as number;
  if (count(r.emailsPerDay)) out.emailsPerDay = r.emailsPerDay as number;
  if (count(r.minIntervalMinutes) && (r.minIntervalMinutes as number) >= 1) {
    out.minIntervalMinutes = r.minIntervalMinutes as number;
  }
  if (r.channelKinds === "all" || (Array.isArray(r.channelKinds) && r.channelKinds.every((k) => (CHANNEL_KINDS as readonly unknown[]).includes(k)))) {
    out.channelKinds = r.channelKinds as PlanLimits["channelKinds"];
  }
  return Object.keys(out).length ? out : null;
}

export function tenantFromRow(row: TenantRow): TenantRecord {
  // The CHECK constraint makes this exact; the fallback is the safe side.
  const billingStatus = oneOf(TENANT_STATUSES, row.status, "suspended");
  return {
    id: row.id,
    accountId: row.account_id,
    slug: row.slug,
    scriptName: row.script_name,
    status: row.owner_suspended_at !== null ? "suspended" : billingStatus,
    billingStatus,
    ownerSuspendedAt: row.owner_suspended_at,
    plan: oneOf(PLAN_IDS, row.plan, "trial"),
    provisionState: oneOf(PROVISION_STATES, row.provision_state, "requested"),
    version: row.version,
    limitOverrides: parseLimitOverrides(row.limit_overrides),
    trialEndsAt: row.trial_ends_at,
  };
}

/**
 * Each public request to <slug>.<domain> needs its tenant row. A short
 * per-isolate cache saves the D1 round trip on busy status pages:
 *   - a ready tenant is kept TENANT_CACHE_MS, so a suspension or plan change
 *     reaches every isolate within that time (forgetTenant clears this
 *     isolate's copy at once, for changes made here);
 *   - an unknown slug is kept UNKNOWN_SLUG_CACHE_MS, short, so a new sign-up
 *     shows up almost at once;
 *   - a tenant still being provisioned is never kept: its "almost ready"
 *     page must turn into the OpenPing as soon as it is ready.
 */
export const TENANT_CACHE_MS = 30_000;
export const UNKNOWN_SLUG_CACHE_MS = 5_000;
const TENANT_CACHE_MAX = 1_000;
const tenantCache = new Map<string, { tenant: TenantRecord | null; until: number }>();

export async function cachedTenantBySlug(db: D1Database, slug: string, now: number = Date.now()): Promise<TenantRecord | null> {
  const hit = tenantCache.get(slug);
  if (hit && hit.until > now) return hit.tenant;
  const tenant = await findTenantBySlug(db, slug);
  if (tenant === null || tenant.provisionState === "ready") {
    if (tenantCache.size >= TENANT_CACHE_MAX) tenantCache.delete(tenantCache.keys().next().value!);
    tenantCache.set(slug, { tenant, until: now + (tenant ? TENANT_CACHE_MS : UNKNOWN_SLUG_CACHE_MS) });
  } else {
    tenantCache.delete(slug);
  }
  return tenant;
}

/** Drops this isolate's cached row for `slug` (after a suspension, a plan change, a removal). */
export function forgetTenant(slug: string): void {
  tenantCache.delete(slug);
}

/** Tests only: start from an empty cache. */
export function clearTenantCache(): void {
  tenantCache.clear();
}

export async function findTenantBySlug(db: D1Database, slug: string): Promise<TenantRecord | null> {
  const row = await db.prepare(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE slug = ?`).bind(slug).first<TenantRow>();
  return row ? tenantFromRow(row) : null;
}

/** The plan's limits with any per-tenant overrides on top. */
export function effectiveLimits(tenant: Pick<TenantRecord, "plan" | "limitOverrides">): PlanLimits {
  return { ...PLAN_LIMITS[tenant.plan], ...(tenant.limitOverrides ?? {}) };
}

/** Where the tenant's OpenPing links back to on the platform. */
export function hostedUrls(slug: string, hostedDomain: string): HostedUrls {
  const app = appOrigin(hostedDomain);
  const tenant = encodeURIComponent(slug);
  return {
    account: `${app}/account`,
    billing: `${app}/billing`,
    upgrade: `${app}/billing/upgrade`,
    signIn: `${app}/sign-in?tenant=${tenant}`,
    signOut: `${app}/sign-out`,
  };
}

export function tenantInfo(tenant: TenantRecord, hostedDomain: string): TenantInfo {
  return {
    id: tenant.id,
    slug: tenant.slug,
    status: tenant.status,
    plan: tenant.plan,
    limits: effectiveLimits(tenant),
    trialEndsAt: tenant.status === "trial" ? tenant.trialEndsAt : null,
    urls: hostedUrls(tenant.slug, hostedDomain),
  };
}
