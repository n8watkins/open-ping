/**
 * What the lifecycle jobs need to know about billing, and nothing more.
 *
 * Billing (build plan, B5, src/billing/) owns a tenant's billing state: it
 * writes tenants.status, tenants.plan and suspended_at, suspends a trial
 * that ended unpaid and a subscription that lapsed, and lifts it on a
 * payment. Lifecycle only reads that state, through this one interface, so
 * the two stay separate modules: `D1BillingView` reads billing's columns
 * (status, trial_ends_at, suspended_at, billing_reason), and the tests can
 * substitute their own.
 *
 * Each list leaves out the tenants lifecycle has already dealt with for that
 * cycle (an email sent or being sent, a deletion waiting on its export), so
 * a run's window of BATCH rows only ever holds work still to do: tenants
 * stuck at the front can't starve the ones behind them.
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

/** A notice already sent, or claimed by a run that is still alive, for a cycle: those tenants are left out. */
export interface Unnotified {
  kind: string;
  /** What names the cycle: a fixed text, or one of the tenant's times. */
  cycle: "once" | "current" | "trial_ends_at" | "suspended_at";
  /** A claim older than this (epoch ms) is a dead run's, and counts as not sent. */
  staleBefore: number;
}

export interface BillingView {
  /** Ready trials ending after `now` and at or before `until`. */
  trialsEnding(now: number, until: number, limit: number, skip: Unnotified): Promise<BillingTenant[]>;
  /** Tenants billing suspended at or before `before`, oldest suspension first. */
  suspended(before: number, limit: number, skip: Unnotified): Promise<BillingTenant[]>;
  /**
   * Tenants billing suspended at or before `before` whose deletion warning
   * was sent at or before `warnedBefore`, and that aren't waiting on an
   * export (one running, or one that failed after `failedSince`).
   */
  dueForDeletion(before: number, warnedBefore: number, failedSince: number, limit: number): Promise<BillingTenant[]>;
  /** Why billing suspended this one. */
  suspensionReason(tenant: BillingTenant): Promise<SuspensionReason>;
  /** Tenants that became ready since `since`, for the welcome email. */
  newlyReady(since: number, limit: number, skip: Unnotified): Promise<BillingTenant[]>;
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

const CYCLE_SQL: Record<Unnotified["cycle"], string> = {
  once: "'once'",
  current: "'current'",
  trial_ends_at: "CAST(t.trial_ends_at AS TEXT)",
  suspended_at: "CAST(t.suspended_at AS TEXT)",
};

/** `AND NOT EXISTS` a sent (or live) notice of this kind for the tenant's cycle; binds kind and staleBefore. */
function unnotified(skip: Unnotified): { sql: string; binds: (string | number)[] } {
  return {
    sql: ` AND NOT EXISTS (SELECT 1 FROM lifecycle_notices n WHERE n.tenant_id = t.id AND n.kind = ? AND n.cycle = ${CYCLE_SQL[skip.cycle]}
             AND (n.state = 'sent' OR n.claimed_at >= ?))`,
    binds: [skip.kind, skip.staleBefore],
  };
}

/** Billing's state as the platform database holds it. */
export class D1BillingView implements BillingView {
  constructor(private readonly db: D1Database) {}

  private async all(where: string, binds: (string | number)[], order: string, limit: number): Promise<BillingTenant[]> {
    // An account being deleted (src/account-deletion.ts) has its own path, and none of these emails.
    const rows = await this.db
      .prepare(`SELECT ${COLUMNS} WHERE (${where}) AND a.deletion_requested_at IS NULL ORDER BY ${order} LIMIT ?`)
      .bind(...binds, limit)
      .all<Row>();
    return rows.results.map(fromRow);
  }

  trialsEnding(now: number, until: number, limit: number, skip: Unnotified) {
    const u = unnotified(skip);
    return this.all(
      `t.status = 'trial' AND t.provision_state = 'ready' AND t.trial_ends_at > ? AND t.trial_ends_at <= ?${u.sql}`,
      [now, until, ...u.binds],
      "t.trial_ends_at",
      limit,
    );
  }

  suspended(before: number, limit: number, skip: Unnotified) {
    const u = unnotified(skip);
    return this.all(
      `t.status = 'suspended' AND t.suspended_at IS NOT NULL AND t.suspended_at <= ? AND t.provision_state <> 'deleting'${u.sql}`,
      [before, ...u.binds],
      "t.suspended_at",
      limit,
    );
  }

  dueForDeletion(before: number, warnedBefore: number, failedSince: number, limit: number) {
    return this.all(
      `t.status = 'suspended' AND t.suspended_at IS NOT NULL AND t.suspended_at <= ? AND t.provision_state <> 'deleting'
       AND EXISTS (SELECT 1 FROM lifecycle_notices n WHERE n.tenant_id = t.id AND n.kind = 'deletion_warning'
                   AND n.cycle = CAST(t.suspended_at AS TEXT) AND n.state = 'sent' AND n.sent_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM tenant_exports e WHERE e.tenant_id = t.id AND e.reason = 'deletion' AND e.created_at >= t.suspended_at
                       AND (e.state IN ('requested', 'exporting') OR (e.state = 'failed' AND e.finished_at > ?)))`,
      [before, warnedBefore, failedSince],
      "t.suspended_at",
      limit,
    );
  }

  /**
   * Billing's own reason (tenants.billing_reason, migration 0006): an ended
   * trial, or anything about the subscription (unpaid, canceled, paused),
   * which the email calls the payment.
   */
  async suspensionReason(tenant: BillingTenant): Promise<SuspensionReason> {
    const row = await this.db.prepare("SELECT billing_reason FROM tenants WHERE id = ?").bind(tenant.tenantId).first<{ billing_reason: string | null }>();
    return row?.billing_reason === "trial_ended" ? "trial_ended" : "payment";
  }

  newlyReady(since: number, limit: number, skip: Unnotified) {
    const u = unnotified(skip);
    return this.all(`t.provision_state = 'ready' AND t.provisioned_at >= ? AND t.status <> 'suspended'${u.sql}`, [since, ...u.binds], "t.provisioned_at", limit);
  }
}
