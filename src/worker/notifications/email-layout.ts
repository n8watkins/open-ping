/**
 * Shared, branded HTML email layout for every OpenPing email (incident down /
 * recovery / test, the weekly summary, and the magic-link sign-in mail).
 *
 * Design goals — maximum cross-client compatibility:
 *  - Table-based structure, every style INLINE (no <style>, no external CSS,
 *    no JS), fluid width capped at ~600px so it reads on mobile.
 *  - A LIGHT body (white card on a light page) with dark ink text is the safe
 *    default: many clients (Gmail, Outlook) force light mode and would wreck a
 *    dark-background design. The brand still shows through a dark header bar,
 *    the accent CTA, and the status pill / accent rail.
 *  - The "ping" glyph from Logo.tsx is recreated with nested border-radius
 *    elements (no SVG — Gmail strips it); it degrades to neat nested squares in
 *    Outlook's Word engine.
 *
 * Pure string builders only — no Env, no I/O — so they unit-test trivially.
 */

/** HTML-escape text for safe interpolation into element bodies and attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Drop a leading status emoji (+ following space) so the HTML heading stays
 *  clean — the colored pill already conveys state. The inbox subject keeps it. */
export function stripLeadingEmoji(s: string): string {
  return s.replace(/^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}️‍\s]+/u, "");
}

// --- Brand palette (email-tuned: accents on a light surface) --------------

// Single-quote the multi-word family: the whole stack is interpolated into
// double-quoted style="" attributes, so "Segoe UI" would close the attribute.
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const BRAND = {
  accent: "#6d8bff", // CTA + "Ping" wordmark (brand accent)
  pageBg: "#eef2f7",
  cardBg: "#ffffff",
  cardBorder: "#e3e9f2",
  headerBg: "#0b1220", // brand canvas — the one dark band
  headerInk: "#e6edf6",
  glyphBg: "#1b2547", // brand accent-soft
  ink: "#16233a",
  inkMuted: "#5f6f87",
  footerBg: "#f7f9fc",
} as const;

/** Per-state accents: a rail/bar color plus a legible pill (tint bg + dark text). */
export interface EmailAccent {
  bar: string;
  pillBg: string;
  pillText: string;
}

const NEUTRAL_ACCENT: EmailAccent = {
  bar: "#6d8bff",
  pillBg: "#e9edff",
  pillText: "#4f6bf0",
};

export const EMAIL_ACCENTS: Record<string, EmailAccent> = {
  up: { bar: "#2fbf6e", pillBg: "#e6f7ee", pillText: "#167c3c" },
  down: { bar: "#ef4757", pillBg: "#fdeaec", pillText: "#cf1b2b" },
  degraded: { bar: "#f5a524", pillBg: "#fdf2e0", pillText: "#a85a08" },
  suspended: { bar: "#a855f7", pillBg: "#f5e9fe", pillText: "#9333ea" },
  neutral: NEUTRAL_ACCENT,
};

export function accentFor(key: string | undefined): EmailAccent {
  return EMAIL_ACCENTS[key ?? "neutral"] ?? NEUTRAL_ACCENT;
}

// --- Layout ---------------------------------------------------------------

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailLayoutOptions {
  /** Visible heading at the top of the card body. */
  heading: string;
  /** Inner HTML for the message body — caller is responsible for escaping. */
  bodyHtml: string;
  /** Accent key ("down" | "up" | "degraded" | "suspended" | "neutral"). */
  accent?: string;
  /** Optional uppercase status pill (e.g. "Down", "Recovered"). */
  statusLabel?: string;
  /** Optional accent CTA button. */
  button?: EmailButton;
  /** Hidden inbox preview text. */
  preheader?: string;
}

/** The concentric "ping" glyph (recreated from Logo.tsx) as a rounded badge. */
function glyph(): string {
  return (
    `<div style="width:38px;height:38px;background:${BRAND.glyphBg};border-radius:10px;text-align:center;line-height:38px;">` +
    `<div style="display:inline-block;vertical-align:middle;width:24px;height:24px;line-height:24px;border-radius:50%;border:1px solid rgba(109,139,255,0.25);text-align:center;">` +
    `<div style="display:inline-block;vertical-align:middle;width:14px;height:14px;line-height:14px;border-radius:50%;border:1px solid rgba(109,139,255,0.55);text-align:center;">` +
    `<span style="display:inline-block;vertical-align:middle;width:7px;height:7px;border-radius:50%;background:${BRAND.accent};"></span>` +
    `</div></div></div>`
  );
}

function header(): string {
  return (
    `<tr><td style="background:${BRAND.headerBg};padding:20px 28px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:middle;padding-right:11px;">${glyph()}</td>` +
    `<td style="vertical-align:middle;font-family:${FONT};font-size:19px;font-weight:700;` +
    `letter-spacing:-0.02em;color:${BRAND.headerInk};">Open<span style="color:${BRAND.accent};">Ping</span></td>` +
    `</tr></table></td></tr>`
  );
}

function pill(label: string, a: EmailAccent): string {
  return (
    `<span style="display:inline-block;background:${a.pillBg};color:${a.pillText};` +
    `font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;` +
    `padding:5px 11px;border-radius:999px;">${escapeHtml(label)}</span>`
  );
}

function button(b: EmailButton): string {
  const href = escapeHtml(b.url);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;"><tr>` +
    `<td style="border-radius:8px;background:${BRAND.accent};">` +
    `<a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${FONT};` +
    `font-size:14px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px;">` +
    `${escapeHtml(b.label)}</a></td></tr></table>`
  );
}

function footer(): string {
  return (
    `<tr><td style="background:${BRAND.footerBg};border-top:1px solid ${BRAND.cardBorder};padding:20px 28px;">` +
    `<p style="margin:0;font-family:${FONT};font-size:13px;color:${BRAND.ink};font-weight:600;">` +
    `OpenPing <span style="color:${BRAND.inkMuted};font-weight:400;">— self-hosted uptime monitoring</span></p>` +
    `<p style="margin:6px 0 0;font-family:${FONT};font-size:12px;color:${BRAND.inkMuted};line-height:1.5;">` +
    `This is an automated message from your OpenPing instance.</p>` +
    `</td></tr>`
  );
}

/** Wrap body content in the full branded, email-client-safe HTML document. */
export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const a = accentFor(opts.accent);
  const pre = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.pageBg};opacity:0;">${escapeHtml(opts.preheader)}</div>`
    : "";
  const pillHtml = opts.statusLabel
    ? `<div style="margin:0 0 14px;">${pill(opts.statusLabel, a)}</div>`
    : "";
  const buttonHtml = opts.button ? button(opts.button) : "";

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<meta name="color-scheme" content="light">` +
    `<meta name="supported-color-schemes" content="light">` +
    `<title>${escapeHtml(opts.heading)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${BRAND.pageBg};-webkit-text-size-adjust:100%;">` +
    pre +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${BRAND.cardBg};border:1px solid ${BRAND.cardBorder};border-radius:14px;overflow:hidden;">` +
    // status accent rail
    `<tr><td style="height:4px;background:${a.bar};line-height:4px;font-size:0;">&nbsp;</td></tr>` +
    header() +
    `<tr><td style="padding:28px;">` +
    pillHtml +
    `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:21px;font-weight:700;line-height:1.3;color:${BRAND.ink};">${escapeHtml(opts.heading)}</h1>` +
    opts.bodyHtml +
    buttonHtml +
    `</td></tr>` +
    footer() +
    `</table></td></tr></table></body></html>`
  );
}

// --- Plain-text counterpart ----------------------------------------------

export interface EmailTextOptions {
  heading: string;
  /** Body lines (already plain). Empty strings render as blank lines. */
  lines: string[];
  button?: EmailButton;
}

/** Build the plain-text alternative with a matching brand footer. */
export function renderEmailText(opts: EmailTextOptions): string {
  const parts: string[] = [opts.heading, "", ...opts.lines];
  if (opts.button) {
    parts.push("", `${opts.button.label}: ${opts.button.url}`);
  }
  parts.push("", "—", "OpenPing — self-hosted uptime monitoring");
  return parts.join("\n");
}
