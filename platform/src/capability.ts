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

import { tenantMailFrom, type Mailer, type MailEnv } from "./mail";
import { recipientState, refusalMessage, requestConfirmation } from "./recipients";
import { effectiveLimits, tenantFromRow } from "./tenants";
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

/** The platform's mailer and the From a tenant's mail goes out as, or null while mail is off. */
export interface TenantMail {
  mailer: Mailer;
  from: string;
  /** For the confirmation links (app.<domain>/email/confirm). */
  hostedDomain: string;
}

/** The tenant mail for this env: Resend with the platform's key, from the Hosted domain. */
export function tenantMailFromEnv(env: MailEnv, mailer: Mailer | null): TenantMail | null {
  const from = tenantMailFrom(env);
  return mailer && from ? { mailer, from, hostedDomain: env.HOSTED_DOMAIN } : null;
}

/**
 * Resend's Idempotency-Key for a tenant's email: the same message to the
 * same address within 24 hours goes out once, so a retry after a lost
 * answer doesn't send it twice. (Resend: unique per request, up to 256
 * characters, kept 24 hours.)
 */
export async function tenantIdempotencyKey(tenantId: string, to: string, message: HostedEmail): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([to, message.subject, message.text, message.html ?? "", message.category]));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `tenant-${tenantId}-${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Limits on what one sendEmail may carry; OpenPing's own mail is far below them. */
export const EMAIL_LIMITS = { recipients: 10, subject: 300, textBytes: 200_000, htmlBytes: 500_000 } as const;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
// One address, no spaces, no angle brackets or commas that could smuggle in a second one.
const ADDRESS_PATTERN = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Why an email from a tenant is refused (one plain phrase), or null when it is fine. */
export function hostedEmailProblem(message: HostedEmail): string | null {
  if (!message || typeof message !== "object") return "not an object";
  if (!Array.isArray(message.to) || message.to.length === 0) return "no recipient";
  if (message.to.length > EMAIL_LIMITS.recipients) return `more than ${EMAIL_LIMITS.recipients} recipients`;
  for (const to of message.to) if (typeof to !== "string" || to.length > 254 || !ADDRESS_PATTERN.test(to)) return "a recipient isn't an email address";
  if (message.replyTo !== undefined && (typeof message.replyTo !== "string" || message.replyTo.length > 254 || !ADDRESS_PATTERN.test(message.replyTo))) {
    return "the reply-to isn't an email address";
  }
  if (typeof message.subject !== "string" || !message.subject.trim() || message.subject.length > EMAIL_LIMITS.subject || /[\r\n]/.test(message.subject)) {
    return "the subject is empty, too long, or has a line break";
  }
  if (typeof message.text !== "string" || bytes(message.text) > EMAIL_LIMITS.textBytes) return "the text is missing or too long";
  if (message.html !== undefined && (typeof message.html !== "string" || bytes(message.html) > EMAIL_LIMITS.htmlBytes)) return "the HTML is too long";
  if (typeof message.category !== "string" || !CATEGORY_PATTERN.test(message.category)) return "the category";
  return null;
}

/** The UTC day of `ms`, as the usage table keys it. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** How long a day's counts are kept, for the console's history and abuse signals. */
export const EMAIL_USAGE_KEEP_DAYS = 35;

/** Old days of email counts, for the cron's cleanup. */
export function emailUsageCleanup(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM tenant_email_usage WHERE day < ?").bind(utcDay(now - EMAIL_USAGE_KEEP_DAYS * 86_400_000));
}

/** One tenant's emails today (UTC): sent, failed, refused by the cap. */
export async function emailsToday(db: D1Database, tenantId: string, now: number): Promise<{ sent: number; failed: number; refused: number }> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(failed), 0) AS failed, COALESCE(SUM(refused), 0) AS refused FROM tenant_email_usage WHERE tenant_id = ? AND day = ?")
    .bind(tenantId, utcDay(now))
    .first<{ sent: number; failed: number; refused: number }>();
  return { sent: row?.sent ?? 0, failed: row?.failed ?? 0, refused: row?.refused ?? 0 };
}

export class TenantCapability implements PlatformCapability {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
    private readonly accountId: string | null,
    private readonly now: () => number = Date.now,
    private readonly mail: TenantMail | null = null,
  ) {}

  /**
   * Sends one email from the platform's domain (contract, section 4), one
   * message per recipient so no recipient sees another, counted against the
   * plan's emailsPerDay for the UTC day: reserved before the send, given
   * back when the provider refuses it. Never throws for a delivery problem.
   */
  async sendEmail(message: HostedEmail): Promise<SendEmailResult> {
    const problem = hostedEmailProblem(message);
    if (problem) return { ok: false, error: "email_rejected", message: `That email can't be sent: ${problem}.` };
    if (!this.mail) return { ok: false, error: "email_unavailable", message: "Email isn't set up on OpenPing Hosted yet." };
    const row = await this.db
      .prepare(
        `SELECT t.id, t.account_id, t.slug, t.script_name, t.status, t.owner_suspended_at, t.plan, t.provision_state, t.version,
                t.limit_overrides, t.trial_ends_at, a.email AS account_email
         FROM tenants t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
      )
      .bind(this.tenantId)
      .first<Parameters<typeof tenantFromRow>[0] & { account_email: string }>();
    if (!row || row.provision_state === "deleting") return { ok: false, error: "email_unavailable", message: "This OpenPing is being removed." };
    const tenant = tenantFromRow(row);
    if (tenant.status === "suspended") return { ok: false, error: "email_unavailable", message: "This OpenPing is paused, so it sends no email." };

    // Only the account's own email and addresses that said yes get mail.
    const allowed: string[] = [];
    const refusals: string[] = [];
    for (const address of [...new Set(message.to.map((t) => t.trim().toLowerCase()))]) {
      const state = await recipientState(this.db, this.tenantId, row.account_email, address);
      if (state === "own" || state === "confirmed") {
        allowed.push(address);
        continue;
      }
      const asked =
        state !== "declined" &&
        (await requestConfirmation({ db: this.db, mailer: this.mail.mailer, hostedDomain: this.mail.hostedDomain, now: this.now() }, tenant, address));
      refusals.push(refusalMessage(state, address, asked));
    }
    if (allowed.length === 0) return { ok: false, error: "email_rejected", message: refusals.join(" ") };
    if (refusals.length) console.warn("[mail] some recipients unconfirmed", { tenant: this.tenantId, refused: refusals.length });
    // A reply-to that isn't one of those is dropped: the Hosted domain's mail never points at a stranger.
    let replyTo: string | undefined;
    if (message.replyTo) {
      const state = await recipientState(this.db, this.tenantId, row.account_email, message.replyTo.trim().toLowerCase());
      if (state === "own" || state === "confirmed") replyTo = message.replyTo;
      else console.warn("[mail] reply-to dropped: not confirmed", { tenant: this.tenantId });
    }

    const limit = effectiveLimits(tenant).emailsPerDay;
    const day = utcDay(this.now());
    const recipients = allowed;
    // Reserve them all at once: one statement, so two sends at the same
    // moment can't both take the last places.
    const reserved = await this.db
      .prepare(
        `INSERT INTO tenant_email_usage (tenant_id, day, category, sent)
         SELECT ?1, ?2, ?3, ?4
         WHERE (SELECT COALESCE(SUM(sent), 0) FROM tenant_email_usage WHERE tenant_id = ?1 AND day = ?2) + ?4 <= ?5
         ON CONFLICT (tenant_id, day, category) DO UPDATE SET sent = sent + excluded.sent`,
      )
      .bind(this.tenantId, day, message.category, recipients.length, limit)
      .run();
    if ((reserved.meta.changes ?? 0) === 0) {
      await this.db
        .prepare(
          `INSERT INTO tenant_email_usage (tenant_id, day, category, refused) VALUES (?, ?, ?, 1)
           ON CONFLICT (tenant_id, day, category) DO UPDATE SET refused = refused + 1`,
        )
        .bind(this.tenantId, day, message.category)
        .run();
      return { ok: false, error: "email_quota_exceeded", message: `Your plan sends up to ${limit} emails a day; the rest go out tomorrow (UTC).` };
    }

    let firstId: string | null = null;
    let failure: SendEmailResult | null = null;
    let failed = 0;
    for (const to of recipients) {
      const result = await this.mail.mailer.send({
        to,
        from: this.mail.from,
        subject: message.subject.trim(),
        text: message.text,
        html: message.html ?? "",
        ...(replyTo ? { replyTo } : {}),
        category: message.category,
        tenantId: this.tenantId,
        idempotencyKey: await tenantIdempotencyKey(this.tenantId, to, message),
      });
      if (result.ok) {
        firstId ??= result.id;
        continue;
      }
      failed++;
      console.error("[mail] tenant email not sent", { tenant: this.tenantId, category: message.category, error: result.error, message: result.message });
      failure ??=
        result.error === "rejected"
          ? { ok: false, error: "email_rejected", message: "The mail provider refused this email." }
          : result.error === "quota"
            ? { ok: false, error: "email_quota_exceeded", message: "OpenPing Hosted can't send more email today; it goes out tomorrow (UTC)." }
            : { ok: false, error: "email_unavailable", message: "The mail provider didn't answer; try again later." };
    }
    if (failed) {
      // Only what went out counts against the day.
      await this.db
        .prepare("UPDATE tenant_email_usage SET sent = MAX(0, sent - ?1), failed = failed + ?1 WHERE tenant_id = ?2 AND day = ?3 AND category = ?4")
        .bind(failed, this.tenantId, day, message.category)
        .run();
    }
    // Every address got it, or none did, for a single-recipient email (all OpenPing sends).
    if (failure && failed === recipients.length) return failure;
    if (failure) console.warn("[mail] tenant email reached only some recipients", { tenant: this.tenantId, failed, of: recipients.length });
    return { ok: true, id: firstId! };
  }

  /**
   * Keeps the tenant's latest counts for the admin console (B6). Counts that
   * are older than the stored ones (a slow call arriving late) change nothing.
   */
  async reportUsage(counts: UsageCounts): Promise<void> {
    const problem = usageCountsProblem(counts);
    if (problem) throw new Error(`usage refused: ${problem}`);
    const now = this.now();
    // Reports are ordered by the tenant's own `at`, as sent: clamping it here
    // would let a late report with a future time pass a newer one. The
    // console clamps only what it shows (admin/data.ts).
    const countedAt = counts.at;
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
