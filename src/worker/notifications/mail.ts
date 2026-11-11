import { isHostedMode, type PlatformCapability, type SendEmailError } from "../../shared/hosted-contract";
import type { Env } from "../types";
import { hitRateLimit } from "../db/rate-limit";
import { sendResendEmail } from "./channels/resend";
import type { SendResult } from "./channels/http";

/**
 * Where OpenPing's email goes out (alerts, the weekly summary, the monthly
 * report, sign-in links).
 *
 * - A plain install sends through Cloudflare Email Service, the Worker's
 *   `EMAIL` send_email binding (no API key), from the `email_from` setting.
 *   Resend (RESEND_API_KEY, channels/resend.ts) stays as an optional transport
 *   for self-hosters who bring their own key: set EMAIL_TRANSPORT=resend to
 *   use it while the EMAIL binding exists, or remove the binding.
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

/** The slice of the Workers `send_email` binding this module uses. */
export interface EmailBinding {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<unknown>;
}

export type MailProvider = "cloudflare" | "resend";

/** Which provider a plain install sends with; null when none is set up. */
export function mailProvider(env: Env): MailProvider | null {
  const wanted = env.EMAIL_TRANSPORT?.trim().toLowerCase();
  if (wanted === "resend") return env.RESEND_API_KEY ? "resend" : null;
  if (wanted === "cloudflare") return env.EMAIL ? "cloudflare" : null;
  // Unset: Cloudflare is the default whenever the binding exists; an install
  // without it that has a Resend key keeps sending through Resend.
  if (env.EMAIL) return "cloudflare";
  return env.RESEND_API_KEY ? "resend" : null;
}

/** The From address used when the `email_from` setting is empty. */
export function defaultFrom(env: Env): string {
  return env.DEFAULT_EMAIL_FROM?.trim() || "OpenPing <onboarding@resend.dev>";
}

/** "Name <a@b.c>" or "a@b.c" as the binding's {email, name}. */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
  const address = m?.[2];
  if (address) return m[1] ? { email: address, name: m[1].replace(/^"|"$/g, "") } : { email: address };
  return { email: from.trim() };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_CAP = 150;

/** Emails per UTC day this install may send (EMAIL_DAILY_CAP, default 150). */
export function emailDailyCap(env: Env): number {
  const n = Number(env.EMAIL_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

/**
 * Cloudflare Email Service through the `EMAIL` binding. Keeps the install under
 * a daily cap (counted in D1, so it holds across Worker isolates) and logs one
 * line per send with the category and never an address. The per-category
 * counts live in `rate_limits` under `email-sent:<category>`, for an admin page.
 */
export function cloudflareTransport(env: Env, now: () => number = Date.now): MailTransport {
  return {
    async send(m) {
      const binding = env.EMAIL;
      if (!binding) return { ok: false, error: "email_not_configured" };
      const t = now();
      const cap = await hitRateLimit(env, "email-sent:all", emailDailyCap(env), { now: t, windowMs: DAY_MS });
      if (!cap.allowed) {
        console.error(JSON.stringify({ event: "email_daily_cap_reached", category: m.category }));
        return { ok: false, error: "email_daily_cap", deferUntil: nextUtcDay(t) };
      }
      try {
        await binding.send({
          to: m.to,
          from: parseFrom(m.from),
          subject: m.subject,
          ...(m.html ? { html: m.html } : {}),
          text: m.text ?? "",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `cloudflare_email_error: ${detail.slice(0, 200)}` };
      }
      console.log(JSON.stringify({ event: "email_sent", category: m.category }));
      await hitRateLimit(env, `email-sent:${m.category}`, Number.MAX_SAFE_INTEGER, { now: t, windowMs: DAY_MS }).catch(() => undefined);
      return { ok: true };
    },
  };
}

/** Resend, with the install's own key (self-host option). */
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
      // A refused email carries the platform's one-sentence reason (an address
      // that hasn't confirmed it wants this OpenPing's email), and the channel
      // shows it as its last error, so the customer knows what to do.
      const reason = result.error === "email_rejected" && typeof result.message === "string" ? result.message.trim().slice(0, 300) : "";
      const failed: SendResult = { ok: false, error: reason ? `${result.error}: ${reason}` : result.error };
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

/** The transport for this call: the platform's in hosted mode, else the install's provider. */
export function mailTransport(env: Env): MailTransport {
  if (!isHostedMode(env.HOSTED_MODE)) {
    return mailProvider(env) === "resend" ? resendTransport(env) : cloudflareTransport(env);
  }
  return env.MAIL_TRANSPORT ?? unavailable;
}

/** Sends one email through this call's transport. */
export function sendEmail(env: Env, message: OutgoingEmail): Promise<SendResult> {
  return mailTransport(env).send(message);
}

/** Can this install send email at all? (Settings and sign-in options say so.) */
export function emailConfigured(env: Env): boolean {
  return isHostedMode(env.HOSTED_MODE) ? !!env.MAIL_TRANSPORT : mailProvider(env) !== null;
}
