/**
 * The platform's own emails (build plan, D2): sign-in, the new-passkey
 * notice, welcome, the trial ending in 3 days and in 1, a failed payment,
 * suspended, and the warning before deletion. Stripe sends the receipts.
 *
 * Each is plain HTML (one column, a 480 px card, real text, one button with
 * the same link written out in the text part) and a text part that says
 * everything the HTML does, so it reads the same in any client, a screen
 * reader or a notification. No images, no tracking, no unsubscribe link:
 * these are about the customer's own account, and go to its email only.
 */

import { SUPPORT_EMAIL, escapeHtml } from "./ui";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#16233a";
const MUTED = "#475569";
const FAINT = "#5f6f87";
const ACCENT = "#3b5bdb";
const DANGER = "#b42335";

type Block =
  | { kind: "p"; text: string }
  | { kind: "note"; text: string }
  | { kind: "code"; text: string }
  | { kind: "facts"; rows: [string, string][] }
  | { kind: "button"; label: string; href: string; tone?: "danger" }
  | { kind: "link"; label: string; href: string };

/** A date the way the emails say it: "Thursday, November 12, 2026" (UTC). */
export function emailDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** A time the way the emails say it: "2026-11-12 14:03 UTC". */
export function emailTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function renderHtml(subject: string, preheader: string, heading: string, blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      switch (b.kind) {
        case "p":
          return `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK};">${escapeHtml(b.text)}</p>`;
        case "note":
          return `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(b.text)}</p>`;
        case "code":
          return `<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;color:${INK};font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(b.text)}</p>`;
        case "facts":
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid #d8e0ea;">${b.rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid #d8e0ea;font-size:14px;color:${MUTED};vertical-align:top;">${escapeHtml(k)}</td><td style="padding:8px 0;border-bottom:1px solid #d8e0ea;font-size:14px;color:${INK};text-align:right;vertical-align:top;">${escapeHtml(v)}</td></tr>`,
            )
            .join("")}</table>`;
        case "link":
          return `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${MUTED};"><a href="${escapeHtml(b.href)}" style="color:${ACCENT};">${escapeHtml(b.label)}</a></p>`;
        case "button":
          return `<p style="margin:4px 0 24px;"><a href="${escapeHtml(b.href)}" style="display:inline-block;background:${b.tone === "danger" ? DANGER : ACCENT};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:12px 20px;border-radius:8px;">${escapeHtml(b.label)}</a></p>`;
      }
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f8fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f6f8fb;font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #d8e0ea;border-radius:14px;">
<tr><td style="padding:28px 24px;font-family:${FONT};color:${INK};">
<p style="margin:0 0 20px;font-size:14px;font-weight:600;color:${MUTED};">OpenPing Hosted</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(heading)}</h1>
${body}
</td></tr></table>
<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${FAINT};">Questions? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:${ACCENT};">${SUPPORT_EMAIL}</a>.</p>
</td></tr></table></body></html>`;
}

function renderText(heading: string, blocks: Block[]): string {
  const lines: string[] = [heading, ""];
  for (const b of blocks) {
    if (b.kind === "p" || b.kind === "note") lines.push(b.text, "");
    else if (b.kind === "code") lines.push(`Code: ${b.text}`, "");
    else if (b.kind === "facts") lines.push(...b.rows.map(([k, v]) => `${k}: ${v}`), "");
    else lines.push(`${b.label}: ${b.href}`, "");
  }
  lines.push("-- ", `OpenPing Hosted. Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`);
  return lines.join("\n");
}

function email(input: { subject: string; preheader: string; heading: string; blocks: Block[] }): RenderedEmail {
  return { subject: input.subject, text: renderText(input.heading, input.blocks), html: renderHtml(input.subject, input.preheader, input.heading, input.blocks) };
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** One sign-in: the code first (it shows in phone notifications), then the link. */
export function signInEmail(input: { code: string; link: string; newAccount: boolean }): RenderedEmail {
  const intro = input.newAccount ? "Here is your code to finish signing up for OpenPing Hosted." : "Here is your code to sign in to OpenPing Hosted.";
  return email({
    subject: `${input.code} is your OpenPing sign-in code`,
    preheader: intro,
    heading: input.newAccount ? "Finish signing up" : "Sign in",
    blocks: [
      { kind: "p", text: intro },
      { kind: "code", text: input.code },
      { kind: "button", label: "Sign in on this device", href: input.link },
      { kind: "note", text: "The code and the link work once, for 15 minutes." },
      { kind: "note", text: "If you didn't ask for this, you can ignore this email; nobody can sign in without it." },
    ],
  });
}

/** The notice every account gets when a passkey is added to it. */
export function passkeyAddedEmail(input: { label: string; at: number; accountUrl: string }): RenderedEmail {
  const intro = `A passkey named "${input.label}" was added to your OpenPing Hosted account at ${emailTime(input.at)}.`;
  return email({
    subject: "A passkey was added to your OpenPing Hosted account",
    preheader: intro,
    heading: "A passkey was added",
    blocks: [
      { kind: "p", text: intro },
      { kind: "note", text: `If that wasn't you, someone can read this inbox: remove the passkey on your account page, change your email password, and write to ${SUPPORT_EMAIL}.` },
      { kind: "button", label: "Open your account", href: input.accountUrl },
    ],
  });
}

/** Sent once the customer's OpenPing is ready. */
export function welcomeEmail(input: { tenantUrl: string; trialEndsAt: number | null; monitors: number }): RenderedEmail {
  const address = host(input.tenantUrl);
  return email({
    subject: "Your OpenPing is ready",
    preheader: `Your OpenPing is ready at ${address}.`,
    heading: "Your OpenPing is ready",
    blocks: [
      { kind: "p", text: `Your OpenPing is ready at ${address}. Add the sites and services you want watched, and it checks them for you and tells you the moment one is down.` },
      { kind: "button", label: "Open your OpenPing", href: input.tenantUrl },
      ...(input.trialEndsAt
        ? [
            {
              kind: "note" as const,
              text: `Your free trial includes ${input.monitors} monitors and runs until ${emailDate(input.trialEndsAt)}. No card is needed until then; we'll email you before it ends.`,
            },
          ]
        : []),
      { kind: "note", text: "Your status page is at the same address, under /status, once you publish it." },
    ],
  });
}

/** Sent 3 days and 1 day before the trial ends. */
export function trialEndingEmail(input: { tenantUrl: string; endsAt: number; daysLeft: number; upgradeUrl: string; deleteAfterDays: number }): RenderedEmail {
  const when = input.daysLeft === 1 ? "tomorrow" : `in ${input.daysLeft} days`;
  return email({
    subject: `Your OpenPing trial ends ${when}`,
    preheader: `Your trial of ${host(input.tenantUrl)} ends ${when}, on ${emailDate(input.endsAt)}.`,
    heading: `Your trial ends ${when}`,
    blocks: [
      { kind: "p", text: `Your free trial of ${host(input.tenantUrl)} ends on ${emailDate(input.endsAt)}. Subscribe before then and your monitors keep running without a gap.` },
      { kind: "button", label: "Choose a plan", href: input.upgradeUrl },
      { kind: "facts", rows: [["Hosted", "$24 a year"], ["With 1-minute checks", "$36 a year"]] },
      {
        kind: "note",
        text: `If you don't subscribe, checks stop when the trial ends. Your monitors and history are kept for ${input.deleteAfterDays} days, then deleted, and we'll email you before that.`,
      },
    ],
  });
}

/** Sent when a renewal payment fails (billing is past due). */
export function paymentFailedEmail(input: { tenantUrl: string; billingUrl: string; suspendAt: number | null }): RenderedEmail {
  return email({
    subject: "Your OpenPing payment didn't go through",
    preheader: "Update your card to keep your monitors running.",
    heading: "Your payment didn't go through",
    blocks: [
      { kind: "p", text: `We couldn't take the payment for ${host(input.tenantUrl)}. Your monitors are still running; update your card and we'll try again.` },
      { kind: "button", label: "Update your card", href: input.billingUrl },
      ...(input.suspendAt
        ? [{ kind: "note" as const, text: `If it still hasn't gone through by ${emailDate(input.suspendAt)}, checks stop until it does.` }]
        : []),
    ],
  });
}

export type SuspendedReason = "trial_ended" | "payment" | "owner";

/** Sent when checks stop: the trial ended unpaid, the payment lapsed, or the owner paused it. */
export function suspendedEmail(input: { tenantUrl: string; reason: SuspendedReason; billingUrl: string; accountUrl: string; deleteAt: number | null }): RenderedEmail {
  const address = host(input.tenantUrl);
  const why =
    input.reason === "trial_ended"
      ? `Your free trial of ${address} has ended, so its checks have stopped and its status page is offline.`
      : input.reason === "payment"
        ? `We still couldn't take the payment for ${address}, so its checks have stopped and its status page is offline.`
        : `${address} has been paused, so its checks have stopped and its status page is offline. We've written to you separately about why.`;
  const blocks: Block[] = [{ kind: "p", text: why }];
  if (input.reason === "owner") {
    blocks.push({ kind: "note", text: `To talk about it, reply to this email or write to ${SUPPORT_EMAIL}.` });
  } else {
    blocks.push({ kind: "p", text: "Nothing is deleted yet. Subscribe, and everything starts again where it stopped." });
    blocks.push({ kind: "button", label: input.reason === "payment" ? "Update your card" : "Choose a plan", href: input.billingUrl });
  }
  if (input.deleteAt) {
    blocks.push({
      kind: "note",
      text: `If it stays paused, your monitors and history are deleted on ${emailDate(input.deleteAt)}. Before that you can download everything from your account page and run it yourself.`,
    });
    blocks.push({ kind: "link", label: "Download everything", href: input.accountUrl });
  }
  return email({ subject: input.reason === "trial_ended" ? "Your OpenPing trial has ended" : "Your OpenPing is paused", preheader: why, heading: "Checks have stopped", blocks });
}

/** Sent a week before a paused OpenPing is deleted, with the way to keep it. */
export function deletionWarningEmail(input: { tenantUrl: string; deleteAt: number; billingUrl: string; accountUrl: string }): RenderedEmail {
  const address = host(input.tenantUrl);
  return email({
    subject: `Your OpenPing will be deleted on ${emailDate(input.deleteAt)}`,
    preheader: `${address} and everything in it will be deleted on ${emailDate(input.deleteAt)}.`,
    heading: "Your OpenPing will be deleted",
    blocks: [
      { kind: "p", text: `${address} has been paused for a while. On ${emailDate(input.deleteAt)}, it is deleted for good: its monitors, history, status pages and settings.` },
      { kind: "p", text: "To keep it running, subscribe before then." },
      { kind: "button", label: "Keep my OpenPing", href: input.billingUrl },
      {
        kind: "note",
        text: "To keep a copy instead, download your export from your account page: it is a backup you can restore into your own free OpenPing on Cloudflare, with the steps to do it.",
      },
      { kind: "link", label: "Open your account to download your export", href: input.accountUrl },
    ],
  });
}

/** Sent to an address a customer's OpenPing wants to email, before any of its mail. */
export function recipientConfirmEmail(input: { tenantUrl: string; confirmUrl: string }): RenderedEmail {
  const address = host(input.tenantUrl);
  return email({
    subject: `Get alerts from ${address}?`,
    preheader: `The OpenPing at ${address} wants to send you its alerts. Nothing is sent until you say yes.`,
    heading: "Get alerts from this OpenPing?",
    blocks: [
      { kind: "p", text: `Someone using OpenPing Hosted at ${address} added this address for its uptime alerts and reports. Nothing is sent until you say yes.` },
      { kind: "button", label: "Answer yes or no", href: input.confirmUrl },
      { kind: "note", text: "If you don't know them, ignore this email or answer no, and it never emails you. The link works for a week." },
    ],
  });
}

/** Sent each time the account's MASTER_KEY is shown on the export page. */
export function keyRevealedEmail(input: { at: number; exportUrl: string }): RenderedEmail {
  const intro = `Your OpenPing's key was shown on your account page at ${emailTime(input.at)}.`;
  return email({
    subject: "Your OpenPing key was shown",
    preheader: intro,
    heading: "Your key was shown",
    blocks: [
      { kind: "p", text: intro },
      { kind: "note", text: `If that was you, moving your OpenPing to your own Cloudflare account, there's nothing to do. If it wasn't, someone can sign in to your account: change your email password and write to ${SUPPORT_EMAIL} at once.` },
      { kind: "link", label: "Your exports", href: input.exportUrl },
    ],
  });
}
