/**
 * What a customer's OpenPing can ask the platform to do (the contract's
 * PlatformCapability), bound to one tenant.
 *
 * src/index.ts exposes this as the `TenantPlatform` entrypoint and hands each
 * dispatched call a stub of it in `props.platform`; tests use the class
 * directly. Inputs come from customer code, so every method validates them.
 * A tenant that sends something malformed gets a thrown error, never a
 * partial write.
 */

import {
  AUDIT_ACTION_PATTERN,
  AUDIT_ACTORS,
  type HostedAuditEvent,
  type HostedEmail,
  type PlatformCapability,
  type SendEmailResult,
  type UsageCounts,
} from "../../src/shared/hosted-contract";

/** Upper bound on an audit event's JSON detail. */
export const AUDIT_DETAIL_MAX_BYTES = 2048;

export class TenantCapability implements PlatformCapability {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
    private readonly accountId: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mail goes through the platform's provider once A5 and B2 wire it; until then nothing is sent. */
  async sendEmail(_message: HostedEmail): Promise<SendEmailResult> {
    return { ok: false, error: "email_unavailable", message: "Email isn't available on OpenPing Hosted yet." };
  }

  /**
   * Keeps the tenant's latest counts for the admin console (B6). Counts that
   * are older than the stored ones (a slow call arriving late) change nothing.
   */
  async reportUsage(counts: UsageCounts): Promise<void> {
    const problem = usageCountsProblem(counts);
    if (problem) throw new Error(`usage refused: ${problem}`);
    const now = this.now();
    // The tenant's clock can't put its counts in the future.
    const countedAt = Math.min(counts.at, now);
    await this.db
      .prepare(
        `INSERT INTO tenant_usage (tenant_id, monitors, status_pages, channels, counted_at, reported_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET monitors = excluded.monitors, status_pages = excluded.status_pages,
           channels = excluded.channels, counted_at = excluded.counted_at, reported_at = excluded.reported_at
         WHERE excluded.counted_at >= tenant_usage.counted_at`,
      )
      .bind(this.tenantId, counts.monitors, counts.statusPages, counts.channels, countedAt, now)
      .run();
  }

  async audit(event: HostedAuditEvent): Promise<void> {
    const problem = auditEventProblem(event);
    if (problem) throw new Error(`audit event refused: ${problem}`);
    const detail = event.detail ? JSON.stringify(event.detail) : null;
    // The time is the platform's, not the tenant's: an audit log can't be backdated.
    await this.db
      .prepare("INSERT INTO audit_events (at, account_id, tenant_id, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(this.now(), this.accountId, this.tenantId, event.actor, event.action, detail)
      .run();
  }
}

/** No tenant has anywhere near this many of anything; more is a bug or an attack. */
export const USAGE_COUNT_MAX = 1_000_000;

/** Why usage counts from a tenant are refused, or null when they are fine. */
export function usageCountsProblem(counts: UsageCounts): string | null {
  if (!counts || typeof counts !== "object") return "not an object";
  for (const key of ["monitors", "statusPages", "channels"] as const) {
    const value = counts[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > USAGE_COUNT_MAX) return key;
  }
  if (typeof counts.at !== "number" || !Number.isSafeInteger(counts.at) || counts.at < 0) return "at";
  return null;
}

/** Why an audit event from a tenant is refused, or null when it is fine. */
export function auditEventProblem(event: HostedAuditEvent): string | null {
  if (!event || typeof event !== "object") return "not an object";
  if (typeof event.action !== "string" || event.action.length > 64 || !AUDIT_ACTION_PATTERN.test(event.action)) {
    return "action";
  }
  if (!(AUDIT_ACTORS as readonly unknown[]).includes(event.actor)) return "actor";
  if (event.detail !== undefined) {
    if (!event.detail || typeof event.detail !== "object" || Array.isArray(event.detail)) return "detail";
    for (const value of Object.values(event.detail)) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return "detail";
    }
    if (new TextEncoder().encode(JSON.stringify(event.detail)).length > AUDIT_DETAIL_MAX_BYTES) return "detail size";
  }
  return null;
}
