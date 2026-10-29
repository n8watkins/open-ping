/**
 * The platform's outgoing mail: one Resend account and one verified sending
 * domain, the Hosted domain, for everything the platform sends: sign-in
 * codes, the account emails (./emails.ts), and every customer's OpenPing's
 * mail through the platform capability (./capability.ts), so no customer
 * ever holds the API key (build plan, section 3).
 *
 * `Mailer` is the interface; `ResendMailer` the real one, and tests use an
 * in-memory outbox (test/fake-mailer.ts), so nothing is ever sent from a test.
 */

import { SUPPORT_EMAIL } from "./ui";
import { errorText, log } from "./log";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The sender; the mailer's own (MAIL_FROM) when absent. Always on the Hosted domain. */
  from?: string;
  replyTo?: string;
  /** What it is ("signin", "alert", "trial_ending", ...), a tag in Resend for metrics. */
  category?: string;
  /** The tenant it was sent for, a tag in Resend. */
  tenantId?: string;
  /**
   * Resend's Idempotency-Key: a retried send with the same key within 24
   * hours goes out once. For emails a job may try again (the account emails).
   */
  idempotencyKey?: string;
  /** Extra email headers, such as List-Unsubscribe (Resend's `headers`). */
  headers?: Record<string, string>;
}

/**
 * - `rejected`: the provider refused this message (an invalid address, an
 *   unverified domain, a bad key); sending it again won't help until fixed.
 * - `quota`: the provider's own daily quota is spent; it resets at midnight UTC.
 * - `unavailable`: no answer, rate limited, or the provider's own failure; try again later.
 */
export type MailError = "rejected" | "quota" | "unavailable";
export type MailResult = { ok: true; id: string } | { ok: false; error: MailError; message: string };

export interface Mailer {
  send(message: OutgoingEmail): Promise<MailResult>;
}

export const RESEND_API = "https://api.resend.com/emails";

/** Resend's error names that are about the moment, not the message (https://resend.com/docs/api-reference/errors). */
const RETRYABLE_NAMES = new Set(["rate_limit_exceeded", "application_error", "service_unavailable", "concurrent_idempotent_requests", "resource_locked"]);

/** What Resend's answer means for this message. */
export function classifyResendError(status: number, name: string | undefined): MailError {
  // Both are spent until a reset, so the mail waits for the next day instead
  // of being retried every few minutes (a month's quota is a day at a time).
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return "quota";
  if ((name && RETRYABLE_NAMES.has(name)) || status === 429 || status >= 500 || status === 0) return "unavailable";
  return "rejected";
}

/** A tag value Resend accepts: ASCII letters, digits, underscores and dashes, at most 256. */
function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

/** Resend's send API: https://resend.com/docs/api-reference/emails/send-email (checked 2026-10-28). */
export class ResendMailer implements Mailer {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly apiKey: string,
    /** "OpenPing Hosted <signin@<domain>>": a verified sending domain (MAIL_FROM). */
    private readonly from: string,
    fetcher?: typeof fetch,
  ) {
    const f = fetcher ?? fetch;
    this.fetcher = (input, init) => f(input, init);
  }

  async send(message: OutgoingEmail): Promise<MailResult> {
    const tags = [
      ...(message.category ? [{ name: "category", value: tagValue(message.category) }] : []),
      ...(message.tenantId ? [{ name: "tenant", value: tagValue(message.tenantId) }] : []),
    ];
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey.slice(0, 256);
    let res: Response;
    try {
      res = await this.fetcher(RESEND_API, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: message.from ?? this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(tags.length ? { tags } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      log.warn("mail.send_failed", { category: message.category, tenant: message.tenantId, error: "unavailable", detail: errorText(error) });
      return { ok: false, error: "unavailable", message: "no answer from the mail provider" };
    }
    const body = (await res.json().catch(() => null)) as { id?: string; name?: string; message?: string } | null;
    // Never the address or the subject: which email it was is the category and the tenant.
    if (res.ok && typeof body?.id === "string") {
      log.info("mail.sent", { category: message.category, tenant: message.tenantId, providerId: body.id });
      return { ok: true, id: body.id };
    }
    const name = typeof body?.name === "string" ? body.name : undefined;
    // Resend's message names the field or the problem; it never echoes the key.
    const detail = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    const error = classifyResendError(res.status, name);
    log.warn("mail.send_failed", { category: message.category, tenant: message.tenantId, status: res.status, error, name });
    return { ok: false, error, message: `mail provider answered ${res.status}${name ? ` ${name}` : ""}${detail}` };
  }
}

/** The address inside "Name <address>", or the whole value; lowercased. */
export function addressOf(from: string): string {
  const match = /<([^<>]+)>\s*$/.exec(from);
  return (match ? match[1]! : from).trim().toLowerCase();
}

/** True when the From's address is on the Hosted domain (or one of its subdomains). */
export function isOnDomain(from: string, hostedDomain: string): boolean {
  const address = addressOf(from);
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = address.slice(at + 1);
  const hosted = hostedDomain.trim().toLowerCase();
  return !!hosted && (domain === hosted || domain.endsWith(`.${hosted}`));
}

export interface MailEnv {
  HOSTED_DOMAIN: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  TENANT_MAIL_FROM?: string;
}

/** Why the platform's mail is off, or null when it is on. */
export function mailProblem(env: MailEnv): string | null {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY isn't set";
  if (!env.MAIL_FROM) return "MAIL_FROM isn't set";
  if (!isOnDomain(env.MAIL_FROM, env.HOSTED_DOMAIN)) return "MAIL_FROM isn't on HOSTED_DOMAIN";
  if (env.TENANT_MAIL_FROM && !isOnDomain(env.TENANT_MAIL_FROM, env.HOSTED_DOMAIN)) return "TENANT_MAIL_FROM isn't on HOSTED_DOMAIN";
  return null;
}

/**
 * The configured mailer, or null until RESEND_API_KEY and a MAIL_FROM on the
 * Hosted domain are both set (the one domain verified in Resend).
 */
export function mailerFromEnv(env: MailEnv, fetcher?: typeof fetch): Mailer | null {
  const problem = mailProblem(env);
  if (problem) return null;
  return new ResendMailer(env.RESEND_API_KEY!, env.MAIL_FROM!, fetcher);
}

/** What a customer's OpenPing's mail goes out as: TENANT_MAIL_FROM, or MAIL_FROM. */
export function tenantMailFrom(env: MailEnv): string | null {
  return mailProblem(env) ? null : (env.TENANT_MAIL_FROM || env.MAIL_FROM!);
}

/** Where a reply to one of the platform's own account emails goes. */
export const PLATFORM_REPLY_TO = SUPPORT_EMAIL;
