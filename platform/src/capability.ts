/**
 * What a customer's OpenPing can ask the platform to do (the contract's
 * PlatformCapability), bound to one tenant.
 *
 * src/index.ts exposes this as the `TenantPlatform` entrypoint and hands each
 * dispatched call a stub of it in `props.platform`; tests use the class
 * directly. Inputs come from customer code, so every method validates them.
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

  /** Accepted and dropped until the admin console (B6) has somewhere to show it. */
  async reportUsage(_counts: UsageCounts): Promise<void> {}

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
