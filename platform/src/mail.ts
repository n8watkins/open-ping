/**
 * The platform's outgoing mail: everything the platform sends (sign-in
 * codes, the account emails in ./emails.ts, and every customer's OpenPing's
 * mail through the platform capability in ./capability.ts) goes through
 * mailroom (github.com/n8watkins/mailroom), the one Worker that holds the
 * account's Cloudflare Email Service binding, over the MAILROOM service
 * binding. No customer, and not this Worker, holds a key (build plan, section 3).
 *
 * `Mailer` is the interface; `MailroomMailer` the real one, and tests use an
 * in-memory outbox (test/fake-mailer.ts), so nothing is ever sent from a test.
 */

import { SUPPORT_EMAIL } from "./ui";
import { errorText, log } from "./log";

/** The platform's three streams, which are mailroom's kinds for the `openping-hosted` app. */
export type MailStream = "signin" | "account" | "tenant";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The sender; the mailer's own (MAIL_FROM) when absent. Always on the Hosted domain. */
  from?: string;
  replyTo?: string;
  /** What it is ("signin", "alert", "trial_ending", ...), logged with every send. */
  category?: string;
  /**
   * Which stream it belongs to: "signin" keeps a reserved share of the
   * account's daily allowance, "tenant" is a customer's OpenPing's mail.
   * "account" when absent.
   */
  stream?: MailStream;
  /** The tenant it was sent for, logged with every send. */
  tenantId?: string;
  /**
   * A retried send with the same key on the same UTC day goes out once. For
   * emails a job may try again (the account emails, tenant mail). mailroom
   * keeps keys for months, so the mailer adds the day to keep the old
   * one-day window: the same alert next week is a new email.
   */
  idempotencyKey?: string;
  /** Extra email headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
}

/**
 * - `rejected`: this message was refused (an invalid or suppressed address, a
 *   sender or kind mailroom doesn't allow); sending it again won't help until fixed.
 * - `quota`: a daily or monthly cap is spent; it resets at midnight UTC.
 * - `unavailable`: no answer, rate limited, or a moment's failure; try again later.
 */
export type MailError = "rejected" | "quota" | "unavailable";
export type MailResult = { ok: true; id: string } | { ok: false; error: MailError; message: string };

export interface Mailer {
  send(message: OutgoingEmail): Promise<MailResult>;
}

/** What mailroom's `send()` takes (github.com/n8watkins/mailroom, src/types.ts). */
export interface MailroomRequest {
  kind: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  key?: string;
}

export type MailroomResult =
  | { ok: true; messageId: string; duplicate?: boolean }
  | { ok: false; code: string; retryable: boolean; message: string };

/** The MAILROOM service binding: entrypoint "Mailroom", props { app: "openping-hosted" } (platform/wrangler.jsonc). */
export interface MailroomBinding {
  send(request: MailroomRequest): Promise<MailroomResult>;
}

/** What one of mailroom's refusal codes means for this message. */
export function classifyMailroomCode(code: string): MailError {
  // Caps are spent until a reset, so the mail waits for the next day instead
  // of being retried every few minutes.
  if (code.startsWith("cap_") || code === "daily_limit") return "quota";
  // A paused app (the owner's switch in mailroom) sends again once resumed.
  if (code === "rate_limited" || code === "unavailable" || code === "in_progress" || code === "paused") return "unavailable";
  return "rejected";
}

/** mailroom's kind for a message: its stream, with a tenant's own sign-in links kept as sign-in. */
export function mailroomKind(message: OutgoingEmail): MailStream {
  const stream = message.stream ?? "account";
  return stream === "tenant" && message.category === "signin" ? "signin" : stream;
}

/** "Name <address>" as its parts; a bare address has no name. */
export function splitFrom(from: string): { address: string; name?: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(from);
  if (!match) return { address: from.trim() };
  const name = match[1]!.trim();
  return { address: match[2]!.trim(), ...(name ? { name } : {}) };
}

export class MailroomMailer implements Mailer {
  constructor(
    private readonly mailroom: MailroomBinding,
    /** "OpenPing Hosted <signin@<domain>>": an address on the Hosted domain (MAIL_FROM). */
    private readonly from: string,
    private readonly now: () => number = Date.now,
  ) {}

  async send(message: OutgoingEmail): Promise<MailResult> {
    const from = splitFrom(message.from ?? this.from);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let result: MailroomResult;
    try {
      result = await this.mailroom.send({
        kind: mailroomKind(message),
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        from: from.address,
        ...(from.name ? { fromName: from.name } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.idempotencyKey ? { key: `${message.idempotencyKey.slice(0, 180)}:${day}` } : {}),
      });
    } catch (error) {
      log.warn("mail.send_failed", { category: message.category, tenant: message.tenantId, error: "unavailable", detail: errorText(error) });
      return { ok: false, error: "unavailable", message: "no answer from mailroom" };
    }
    // Never the address or the subject: which email it was is the category and the tenant.
    if (result.ok) {
      log.info("mail.sent", { category: message.category, tenant: message.tenantId, providerId: result.messageId, duplicate: result.duplicate === true });
      return { ok: true, id: result.messageId };
    }
    const error = classifyMailroomCode(result.code);
    log.warn("mail.send_failed", { category: message.category, tenant: message.tenantId, error, code: result.code });
    return { ok: false, error, message: `mailroom refused it: ${result.code}` };
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
  MAILROOM?: MailroomBinding;
  MAIL_FROM?: string;
  TENANT_MAIL_FROM?: string;
}

/** Why the platform's mail is off, or null when it is on. */
export function mailProblem(env: MailEnv): string | null {
  if (!env.MAILROOM) return "the MAILROOM binding isn't set";
  if (!env.MAIL_FROM) return "MAIL_FROM isn't set";
  if (!isOnDomain(env.MAIL_FROM, env.HOSTED_DOMAIN)) return "MAIL_FROM isn't on HOSTED_DOMAIN";
  if (env.TENANT_MAIL_FROM && !isOnDomain(env.TENANT_MAIL_FROM, env.HOSTED_DOMAIN)) return "TENANT_MAIL_FROM isn't on HOSTED_DOMAIN";
  return null;
}

/**
 * The configured mailer, or null until the MAILROOM binding and a MAIL_FROM
 * on the Hosted domain are both set (the domain onboarded for Email Sending
 * and listed as openping-hosted's sender in mailroom).
 */
export function mailerFromEnv(env: MailEnv, now?: () => number): Mailer | null {
  const problem = mailProblem(env);
  if (problem) return null;
  return new MailroomMailer(env.MAILROOM!, env.MAIL_FROM!, now);
}

/** What a customer's OpenPing's mail goes out as: TENANT_MAIL_FROM, or MAIL_FROM. */
export function tenantMailFrom(env: MailEnv): string | null {
  return mailProblem(env) ? null : (env.TENANT_MAIL_FROM || env.MAIL_FROM!);
}

/** Where a reply to one of the platform's own account emails goes. */
export const PLATFORM_REPLY_TO = SUPPORT_EMAIL;
