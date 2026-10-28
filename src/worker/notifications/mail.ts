import { isHostedMode, type PlatformCapability, type SendEmailError } from "../../shared/hosted-contract";
import type { Env } from "../types";
import { sendResendEmail } from "./channels/resend";
import type { SendResult } from "./channels/http";

/**
 * Where OpenPing's email goes out (alerts, the weekly summary, the monthly
 * report, sign-in links).
 *
 * - A plain install sends through Resend with its own RESEND_API_KEY, from the
 *   `email_from` setting (channels/resend.ts), exactly as before.
 * - In hosted mode it sends only through the platform's capability
 *   (`props.platform.sendEmail`, docs/hosted/CONTRACT.md, section 4), which
 *   picks the From address and counts the tenant's daily cap. The hosted gate
 *   puts that transport on this call's env as MAIL_TRANSPORT; the stub is valid
 *   for this call only, and so is that env.
 */

/** One email, already rendered. */
export interface OutgoingEmail {
  /** The From address. A plain install's own; the platform ignores it and uses its verified domain. */
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** What it is, for the platform's per-tenant metrics and cap. */
  category: MailCategory;
}

export type MailCategory = "alert" | "report" | "signin" | "waitlist";

export interface MailTransport {
  send(message: OutgoingEmail): Promise<SendResult>;
}

/** Today's sender: Resend, with the install's own key. */
export function resendTransport(env: Env): MailTransport {
  return {
    send: (m) => sendResendEmail(env, { from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text }),
  };
}

/** The next UTC midnight after `now`, when the platform's daily email cap starts over. */
export function nextUtcDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}

/**
 * The platform's sender (hosted mode). Its answers map onto the same result
 * every channel gives the outbox: a send over the daily cap waits for the next
 * UTC day, and an RPC that throws counts as `email_unavailable`, to retry.
 */
export function platformTransport(platform: PlatformCapability, now: () => number = Date.now): MailTransport {
  return {
    async send(m) {
      // The platform needs text; a message rendered as HTML only gets none.
      const text = m.text ?? "";
      let result: Awaited<ReturnType<PlatformCapability["sendEmail"]>>;
      try {
        result = await platform.sendEmail({
          to: [m.to],
          subject: m.subject,
          text,
          ...(m.html ? { html: m.html } : {}),
          category: m.category,
        });
      } catch (error) {
        console.error("[mail] the platform's sendEmail failed", error);
        return { ok: false, error: "email_unavailable" satisfies SendEmailError };
      }
      if (result.ok) return { ok: true };
      const failed: SendResult = { ok: false, error: result.error };
      // Over the daily cap: nothing can go out before the next UTC day, so the
      // outbox waits for it without spending an attempt (db/outbox.ts markDeferred).
      if (result.error === "email_quota_exceeded") failed.deferUntil = nextUtcDay(now());
      return failed;
    },
  };
}

/** A hosted Worker without its platform transport (it has no props): nothing to send with. */
const unavailable: MailTransport = {
  async send() {
    return { ok: false, error: "email_unavailable" satisfies SendEmailError };
  },
};

/** The transport for this call: the platform's in hosted mode, Resend otherwise. */
export function mailTransport(env: Env): MailTransport {
  if (!isHostedMode(env.HOSTED_MODE)) return resendTransport(env);
  return env.MAIL_TRANSPORT ?? unavailable;
}

/** Sends one email through this call's transport. */
export function sendEmail(env: Env, message: OutgoingEmail): Promise<SendResult> {
  return mailTransport(env).send(message);
}

/** Can this install send email at all? (Settings and sign-in options say so.) */
export function emailConfigured(env: Env): boolean {
  return isHostedMode(env.HOSTED_MODE) ? !!env.MAIL_TRANSPORT : !!env.RESEND_API_KEY;
}
