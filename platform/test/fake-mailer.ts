/**
 * An in-memory Mailer: every message the platform would send, kept for the
 * test to read, and failures on demand. Same interface as ResendMailer.
 */

import type { MailError, MailResult, Mailer, OutgoingEmail } from "../src/mail";

export class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  /** Every send fails this way while set. */
  fail: MailError | null = null;
  /** The next sends fail this way, one each. */
  failNext: MailError[] = [];

  async send(message: OutgoingEmail): Promise<MailResult> {
    const error = this.failNext.shift() ?? this.fail;
    if (error) return { ok: false, error, message: `injected ${error}` };
    this.sent.push(message);
    return { ok: true, id: `m${this.sent.length}` };
  }

  to(address: string): OutgoingEmail[] {
    return this.sent.filter((m) => m.to === address);
  }

  lastCode(): string {
    return /Code: (\d{6})/.exec(this.sent.at(-1)!.text)![1]!;
  }
}
