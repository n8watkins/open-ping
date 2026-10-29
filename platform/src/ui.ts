/**
 * The platform's HTML shell and components: sign-up, sign-in, the account
 * page, and the few status pages (./pages.ts).
 *
 * Plain server-rendered HTML in OpenPing's design tokens (src/client/index.css):
 * the dark navy shell by default and the light palette when the visitor's
 * system asks for it. Designed phone first, to the mobile standard in
 * docs/MOBILE_PLAN.md: one column, 48 px controls, 16 px inputs (no zoom on
 * focus), the right keyboards, safe areas. The only script is the passkey
 * helper (./client-script.ts), served from this origin, so the CSP allows
 * no inline script at all.
 */

export const SUPPORT_EMAIL = "support@n8builds.dev";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Markup that is already safe; everything else passed to `html` is escaped. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Interpolated = Html | string | number | null | undefined | false | readonly Interpolated[];

function render(value: Interpolated): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

/** A template tag that escapes every interpolation unless it is Html. */
export function html(strings: TemplateStringsArray, ...values: Interpolated[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

const TOKENS_DARK = `
  --canvas: #0b1220; --surface: #111b2e; --surface-2: #16233a; --line: #1f2c44;
  --ink: #e6edf6; --ink-muted: #9fb0c5; --ink-faint: #8595ad;
  --accent: #6d8bff; --accent-hover: #859dff; --accent-soft: #1b2547; --link: #859dff;
  --up: #2fbf6e; --down: #f76d79; --suspended: #c084fc; --degraded: #f5a524;`;

const TOKENS_LIGHT = `
  --canvas: #f6f8fb; --surface: #ffffff; --surface-2: #eef2f7; --line: #d8e0ea;
  --ink: #16233a; --ink-muted: #475569; --ink-faint: #5f6f87;
  --accent-soft: #e3e9ff; --link: #3b5bdb;
  --up: #15803d; --down: #c81e3a; --suspended: #9333ea; --degraded: #a85a08;`;

export const STYLE = `
:root { color-scheme: dark light; ${TOKENS_DARK} }
@media (prefers-color-scheme: light) { :root { ${TOKENS_LIGHT} } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0; min-height: 100%; }
body {
  background: var(--canvas); color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; line-height: 1.5;
  display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh;
  padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
main {
  width: 100%; max-width: 28rem; margin: auto; background: var(--surface);
  border: 1px solid var(--line); border-radius: 0.875rem; padding: 24px 20px;
}
main.wide { max-width: 40rem; }
@media (min-width: 640px) { main { padding: 32px; } }
.brand { display: flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 0.875rem; font-weight: 600; margin: -12px 0 8px; padding: 12px 0; width: fit-content; text-decoration: none; }
.dot { width: 10px; height: 10px; border-radius: 999px; background: var(--accent); flex: none; }
.badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--tone, var(--link)); margin: 0 0 12px; }
h1 { font-size: 1.375rem; line-height: 1.3; margin: 0 0 8px; font-weight: 650; overflow-wrap: anywhere; }
h2 { font-size: 1rem; line-height: 1.4; margin: 0 0 4px; font-weight: 650; }
p { margin: 0 0 12px; color: var(--ink-muted); overflow-wrap: anywhere; }
a { color: var(--link); }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lead { margin-bottom: 20px; }
form { margin: 0; }
.field { margin: 0 0 16px; }
label { display: block; font-size: 0.875rem; font-weight: 600; color: var(--ink); margin: 0 0 6px; }
.hint { font-size: 0.8125rem; color: var(--ink-faint); margin: 6px 0 0; }
input[type=email], input[type=text], input[type=number] {
  display: block; width: 100%; min-height: 48px; padding: 10px 14px; font: inherit; font-size: 16px;
  color: var(--ink); background: var(--canvas); border: 1px solid var(--line); border-radius: 0.5rem;
}
input::placeholder { color: var(--ink-faint); opacity: 1; }
input:focus-visible { outline-offset: 0; border-color: var(--accent); }
.suffix { display: flex; align-items: stretch; }
.suffix input { border-top-right-radius: 0; border-bottom-right-radius: 0; min-width: 0; flex: 1; }
.suffix span { display: flex; align-items: center; padding: 0 12px; border: 1px solid var(--line); border-left: 0; border-radius: 0 0.5rem 0.5rem 0; background: var(--surface-2); color: var(--ink-muted); font-size: 0.875rem; white-space: nowrap; max-width: 55%; overflow: hidden; text-overflow: ellipsis; }
input.code { text-align: center; font-size: 1.5rem; letter-spacing: 0.35em; padding-left: calc(14px + 0.35em); font-variant-numeric: tabular-nums; }
.button {
  display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 48px;
  padding: 10px 16px; font: inherit; font-size: 1rem; font-weight: 600; line-height: 1.2; text-align: center;
  border-radius: 0.5rem; border: 1px solid transparent; cursor: pointer; text-decoration: none;
  transition: background-color 120ms cubic-bezier(0.25, 1, 0.5, 1), border-color 120ms cubic-bezier(0.25, 1, 0.5, 1);
}
/* The app's primary button: accent fill, canvas-navy text. */
.button.primary { background: var(--accent); color: #0b1220; }
.button.primary:hover { background: var(--accent-hover); }
.button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
.button.secondary:hover { background: var(--surface-2); }
.button.danger { background: transparent; color: var(--down); border-color: var(--line); }
.button.small { width: auto; min-height: 44px; padding: 8px 14px; font-size: 0.875rem; }
.button svg { width: 20px; height: 20px; flex: none; }
.button[disabled] { opacity: 0.6; cursor: progress; }
.stack > * + * { margin-top: 12px; }
.or { display: flex; align-items: center; gap: 12px; color: var(--ink-faint); font-size: 0.8125rem; margin: 20px 0; }
.or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
.notice { border: 1px solid var(--line); border-left: 3px solid var(--tone, var(--accent)); border-radius: 0.5rem; padding: 10px 12px; margin: 0 0 16px; font-size: 0.875rem; color: var(--ink); background: var(--surface-2); }
.notice.error { --tone: var(--down); }
.notice.ok { --tone: var(--up); }
.notice[hidden] { display: none; }
section { border-top: 1px solid var(--line); padding-top: 20px; margin-top: 20px; }
.rows { list-style: none; margin: 12px 0 0; padding: 0; }
.rows li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); min-height: 56px; }
.rows li:first-child { border-top: 0; }
.rows .what { min-width: 0; }
.rows .what strong { display: block; font-weight: 600; overflow-wrap: anywhere; }
.rows .what span { display: block; font-size: 0.8125rem; color: var(--ink-faint); overflow-wrap: anywhere; }
.email { display: block; color: var(--ink); overflow-wrap: anywhere; }
.address { font-size: 1.0625rem; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; margin: 0 0 4px; }
.fine { font-size: 0.8125rem; color: var(--ink-faint); margin: 20px 0 0; }
.switch { text-align: center; font-size: 0.875rem; margin: 20px 0 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875em; color: var(--ink); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .button { transition: none; } }
`;

export const GITHUB_ICON = new Html(
  `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
);

export const PASSKEY_ICON = new Html(
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21v-1a6 6 0 0 1 9.5-4.9"/><circle cx="18" cy="13" r="2.5"/><path d="M18 15.5V21l1.5-1.5L18 18"/></svg>`,
);

export interface PageOptions {
  title: string;
  main: Html;
  status?: number;
  /** Same-origin scripts to load (the passkey helper). Without any, the CSP allows no script. */
  scripts?: string[];
  wide?: boolean;
  /** The admin console's wider, top-aligned card (./admin/pages.ts). */
  admin?: boolean;
  /** Replaces the brand line at the top of the card (the console's header and tabs). */
  header?: Html;
  /** CSS added after the shared stylesheet. */
  style?: string;
  /** False leaves out the "Questions? Write to support" line (the owner's own pages). */
  footer?: boolean;
  /**
   * Go on to this address at once, by GET (a meta refresh; the page also
   * links it). For a form post whose next stop is another origin: the CSP's
   * form-action 'self' covers every redirect after a post, so a 303 there is
   * blocked, but a navigation from a page is not a form submission.
   */
  redirectTo?: string;
  /** Reload the page after this many seconds (the "setting up" state). */
  refreshSeconds?: number;
  headers?: Record<string, string>;
  /** Where the brand links; the platform's home by default. */
  homeHref?: string;
}

/** The CSP for a page: nothing from elsewhere, forms only to this origin, scripts only when asked. */
export function contentSecurityPolicy(withScripts: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    withScripts ? "script-src 'self'" : null,
    withScripts ? "connect-src 'self'" : null,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join("; ");
}

export function renderPage(options: PageOptions): Response {
  const scripts = options.scripts ?? [];
  const refresh = options.redirectTo
    ? html`<meta http-equiv="refresh" content="0;url=${options.redirectTo}">`
    : options.refreshSeconds
      ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">`
      : "";
  const body = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b1220">
${refresh}<title>${options.title} - OpenPing Hosted</title>
<style>${new Html(STYLE)}${new Html(options.style ?? "")}</style>
${scripts.map((src) => html`<script src="${src}" defer></script>`)}
</head>
<body>
<main${options.admin ? new Html(' class="admin"') : options.wide ? new Html(' class="wide"') : ""}>
${options.header ?? html`<a class="brand" href="${options.homeHref ?? "/"}"><span class="dot" aria-hidden="true"></span>OpenPing Hosted</a>`}
${options.main}
${options.footer === false ? "" : html`<p class="fine">Questions? Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`}
</main>
</body>
</html>
`;
  return new Response(body.value, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy(scripts.length > 0),
      "x-content-type-options": "nosniff",
      // Not no-referrer: with it, browsers send `Origin: null` on this page's own
      // form posts. same-origin still tells other sites nothing.
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      ...options.headers,
    },
  });
}

export function notice(message: string | null | undefined, tone: "error" | "ok" | "info" = "error"): Html {
  if (!message) return new Html("");
  const cls = tone === "info" ? "notice" : `notice ${tone}`;
  return html`<p class="${cls}" role="${tone === "error" ? "alert" : "status"}">${message}</p>`;
}
