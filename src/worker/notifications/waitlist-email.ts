import { escapeHtml, renderEmailLayout, renderEmailText } from "./email-layout";
import { PENDING_DAYS } from "../db/waitlist";
import type { OutgoingEmail } from "./mail";

/**
 * The one email the Hosted waitlist sends: confirm your address (the double
 * opt-in). It carries the leave link, and the headers mail apps use for their
 * own unsubscribe button (RFC 8058: a https List-Unsubscribe URL, and
 * List-Unsubscribe-Post to say a POST to it leaves with no page and no login).
 * It never repeats anything the visitor typed beyond the address it goes to.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const confirmUrl = (origin: string, token: string) => `${origin}/waitlist/confirm?t=${encodeURIComponent(token)}`;
export const leaveUrl = (origin: string, token: string) => `${origin}/waitlist/leave?t=${encodeURIComponent(token)}`;

export const CONFIRM_SUBJECT = "Confirm your spot on the OpenPing Hosted waitlist";

function paragraph(html: string): string {
  return `<p class="op-ink" style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:#16233a;">${html}</p>`;
}

export function renderConfirmEmail(origin: string, links: { confirm: string; leave: string }): Pick<OutgoingEmail, "subject" | "html" | "text" | "headers"> {
  const confirm = confirmUrl(origin, links.confirm);
  const leave = leaveUrl(origin, links.leave);
  const html = renderEmailLayout({
    heading: "One click to join the waitlist",
    preheader: "Confirm your address to join the OpenPing Hosted waitlist.",
    adaptive: true,
    bodyHtml:
      paragraph("Someone, hopefully you, asked to join the waitlist for OpenPing Hosted. Confirm, and I will email you once, when Hosted opens, with early pricing. Nothing else: no newsletter."),
    button: { label: "Confirm my spot", url: confirm },
    footerHtml: `Not you? Ignore this email. Nothing changes unless you confirm, and an unconfirmed request is deleted after ${PENDING_DAYS} days.<br><span style="word-break:break-all;">Button not working? Open ${escapeHtml(confirm)}</span><br>Changed your mind? <a href="${escapeHtml(leave)}" style="color:inherit;text-decoration:underline;">Leave the waitlist</a> at any time, in one click.`,
  });
  const text = renderEmailText({
    heading: "One click to join the waitlist",
    lines: [
      "Someone, hopefully you, asked to join the waitlist for OpenPing Hosted.",
      "Confirm, and I will email you once, when Hosted opens, with early pricing. Nothing else: no newsletter.",
      "",
      `Not you? Ignore this email. Nothing changes unless you confirm, and an unconfirmed request is deleted after ${PENDING_DAYS} days.`,
      "",
      `Leave the waitlist at any time, in one click: ${leave}`,
    ],
    button: { label: "Confirm my spot", url: confirm },
  });
  return {
    subject: CONFIRM_SUBJECT,
    html,
    text,
    headers: { "List-Unsubscribe": `<${leave}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
