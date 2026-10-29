/**
 * What the lifecycle jobs need to know about billing, and nothing more.
 *
 * Billing (build plan, B5, src/billing/) owns a tenant's billing state: it
 * writes tenants.status, tenants.plan and suspended_at, suspends a trial
 * that ended unpaid and a subscription that lapsed, and lifts it on a
 * payment. Lifecycle only reads that state, through this one interface, so
 * the two stay separate modules: `D1BillingView` reads the columns every
 * version of the schema has (status, trial_ends_at, suspended_at, and the
 * subscriptions table from migration 0001), and the tests use a fake.
 *
 * Lifecycle never changes billing's columns. The owner's own suspension
 * (owner_suspended_at) is not billing's and never starts the deletion clock.
 */

import type { TenantStatus } from "../../../src/shared/hosted-contract";

/** Why billing suspended a tenant, for the email's wording. */
export type SuspensionReason = "trial_ended" | "payment";

export interface BillingTenant {
  tenantId: string;
  accountId: string;
  /** The account's email, where every lifecycle email goes. */
  email: string;
  slug: string;
  status: TenantStatus;
  trialEndsAt: number | null;
  /** When billing suspended it (tenants.suspended_at), while status is suspended. */
  suspendedAt: number | null;
  provisionedAt: number | null;
}

export interface BillingView {
  /** Ready trials ending at or before `until` and not yet ended. */
  trialsEnding(now: number, until: number, limit: number): Promise<BillingTenant[]>;
  /** Tenants billing has past due (a renewal failed; Stripe is retrying). */
  pastDue(limit: number): Promise<BillingTenant[]>;
  /** Tenants billing has suspended, oldest suspension first, with when. */
  suspended(limit: number): Promise<BillingTenant[]>;
  /** Why billing suspended this one. */
  suspensionReason(tenant: BillingTenant): Promise<SuspensionReason>;
  /** Tenants that became ready since `since`, for the welcome email. */
  newlyReady(since: number, limit: number): Promise<BillingTenant[]>;
}

const COLUMNS = `t.id, t.account_id, a.email, t.slug, t.status, t.trial_ends_at, t.suspended_at, t.provisioned_at
  FROM tenants t JOIN accounts a ON a.id = t.account_id`;

interface Row {
  id: string;
  account_id: string;
  email: string;
  slug: string;
  status: TenantStatus;
  trial_ends_at: number | null;
  suspended_at: number | null;
  provisioned_at: number | null;
}

const fromRow = (r: Row): BillingTenant => ({
  tenantId: r.id,
  accountId: r.account_id,
  email: r.email,
  slug: r.slug,
  status: r.status,
  trialEndsAt: r.trial_ends_at,
  suspendedAt: r.suspended_at,
  provisionedAt: r.provisioned_at,
});

/** Billing's state as the platform database holds it. */
export class D1BillingView implements BillingView {
  constructor(private readonly db: D1Database) {}

  private async all(sql: string, ...binds: (string | number)[]): Promise<BillingTenant[]> {
    const rows = await this.db.prepare(`SELECT ${COLUMNS} ${sql}`).bind(...binds).all<Row>();
    return rows.results.map(fromRow);
  }

  trialsEnding(now: number, until: number, limit: number) {
    return this.all(
      "WHERE t.status = 'trial' AND t.provision_state = 'ready' AND t.trial_ends_at > ? AND t.trial_ends_at <= ? ORDER BY t.trial_ends_at LIMIT ?",
      now,
      until,
      limit,
    );
  }

  pastDue(limit: number) {
    return this.all("WHERE t.status = 'past_due' AND t.provision_state = 'ready' ORDER BY t.id LIMIT ?", limit);
  }

  suspended(limit: number) {
    return this.all(
      "WHERE t.status = 'suspended' AND t.suspended_at IS NOT NULL AND t.provision_state <> 'deleting' ORDER BY t.suspended_at LIMIT ?",
      limit,
    );
  }

  /**
   * A trial that ended without the account ever having a subscription was
   * suspended for the trial; anything else, for its payment. (Billing keeps
   * the exact reason in a column of its own; this reads only what every
   * schema has.)
   */
  async suspensionReason(tenant: BillingTenant): Promise<SuspensionReason> {
    const sub = await this.db.prepare("SELECT 1 AS x FROM subscriptions WHERE account_id = ? LIMIT 1").bind(tenant.accountId).first();
    return !sub && tenant.trialEndsAt !== null && tenant.suspendedAt !== null && tenant.trialEndsAt <= tenant.suspendedAt ? "trial_ended" : "payment";
  }

  newlyReady(since: number, limit: number) {
    return this.all("WHERE t.provision_state = 'ready' AND t.provisioned_at >= ? ORDER BY t.provisioned_at LIMIT ?", since, limit);
  }
}
