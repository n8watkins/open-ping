/**
 * The platform's outgoing mail: sign-in codes now, and the account emails
 * (D2) later. One provider, Resend, behind a small interface so tests use
 * an in-memory outbox and nothing is ever sent from a test.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailResult = { ok: true; id: string } | { ok: false; error: string };

export interface Mailer {
  send(message: OutgoingEmail): Promise<MailResult>;
}

/** Resend's send API: https://resend.com/docs/api-reference/emails/send-email */
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
    let res: Response;
    try {
      res = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { ok: false, error: "no answer from the mail provider" };
    }
    const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
    if (!res.ok || typeof body?.id !== "string") return { ok: false, error: `mail provider answered ${res.status}` };
    return { ok: true, id: body.id };
  }
}

/** The configured mailer, or null until RESEND_API_KEY and MAIL_FROM are both set. */
export function mailerFromEnv(env: { RESEND_API_KEY?: string; MAIL_FROM?: string }): Mailer | null {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return null;
  return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
}
