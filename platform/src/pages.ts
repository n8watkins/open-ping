/**
 * The few pages the platform answers with itself, before any customer's
 * OpenPing is involved: no such OpenPing, one that is suspended or still
 * being set up, and the placeholder home of app.<domain>.
 *
 * Plain HTML with inline CSS and no scripts, in OpenPing's design tokens
 * (src/client/index.css): the dark navy shell by default, and the light
 * palette when the visitor's system asks for it.
 */

export const SUPPORT_EMAIL = "support@n8builds.dev";

const TOKENS_DARK = `
  --canvas: #0b1220; --surface: #111b2e; --line: #1f2c44;
  --ink: #e6edf6; --ink-muted: #9fb0c5; --ink-faint: #8595ad;
  --accent: #6d8bff; --accent-hover: #859dff; --accent-soft: #1b2547; --link: #859dff;
  --suspended: #c084fc; --degraded: #f5a524;`;

const TOKENS_LIGHT = `
  --canvas: #f6f8fb; --surface: #ffffff; --line: #d8e0ea;
  --ink: #16233a; --ink-muted: #475569; --ink-faint: #5f6f87;
  --accent-soft: #e3e9ff; --link: #3b5bdb;
  --suspended: #9333ea; --degraded: #a85a08;`;

const STYLE = `
:root { color-scheme: dark light; ${TOKENS_DARK} }
@media (prefers-color-scheme: light) { :root { ${TOKENS_LIGHT} } }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  background: var(--canvas); color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; line-height: 1.5;
  display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  min-height: 100vh;
}
main {
  width: 100%; max-width: 30rem; background: var(--surface);
  border: 1px solid var(--line); border-radius: 0.875rem; padding: 28px 24px;
}
.brand { display: flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 0.875rem; font-weight: 600; margin: 0 0 20px; }
.dot { width: 10px; height: 10px; border-radius: 999px; background: var(--accent); }
.badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--tone, var(--link)); margin: 0 0 12px; }
h1 { font-size: 1.375rem; line-height: 1.3; margin: 0 0 8px; font-weight: 650; overflow-wrap: anywhere; }
p { margin: 0 0 12px; color: var(--ink-muted); overflow-wrap: anywhere; }
.actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
/* The app's primary button: accent fill, canvas-navy text (Button styles in src/client). */
a.button { display: inline-block; background: var(--accent); color: #0b1220; text-decoration: none; font-weight: 500; font-size: 0.875rem; padding: 8px 16px; border-radius: 0.5rem; transition: background-color 120ms cubic-bezier(0.25, 1, 0.5, 1); }
a.button:hover { background: var(--accent-hover); }
a { color: var(--link); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fine { font-size: 0.8125rem; color: var(--ink-faint); margin-top: 20px; margin-bottom: 0; }
@media (prefers-reduced-motion: reduce) { a.button { transition: none; } }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875em; color: var(--ink); }
`;

/** Every platform page: no scripts, nothing framed, nothing cached. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface PageInput {
  title: string;
  badge?: { text: string; tone?: "accent" | "suspended" | "degraded" };
  /** Already-escaped HTML paragraphs. */
  body: string[];
  action?: { href: string; label: string };
  status: number;
  headers?: Record<string, string>;
}

function page(input: PageInput): Response {
  const tone = input.badge?.tone && input.badge.tone !== "accent" ? ` style="--tone: var(--${input.badge.tone})"` : "";
  const badge = input.badge ? `<p class="badge"${tone}>${escapeHtml(input.badge.text)}</p>` : "";
  const action = input.action
    ? `<div class="actions"><a class="button" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a></div>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)} - OpenPing</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand"><span class="dot" aria-hidden="true"></span>OpenPing Hosted</p>
${badge}<h1>${escapeHtml(input.title)}</h1>
${input.body.map((p) => `<p>${p}</p>`).join("\n")}
${action}
<p class="fine">Questions? Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
</main>
</body>
</html>
`;
  return new Response(html, { status: input.status, headers: { ...PAGE_HEADERS, ...input.headers } });
}

/** No customer OpenPing at this address (unknown, reserved or invalid slug). */
export function tenantNotFoundPage(host: string, appUrl: string): Response {
  return page({
    status: 404,
    title: "There's no OpenPing here",
    body: [`Nothing is set up at <code>${escapeHtml(host)}</code> yet.`, "Check the address, or start your own uptime monitor and status page in about a minute."],
    action: { href: appUrl, label: "Go to OpenPing Hosted" },
  });
}

/** The tenant exists but is suspended: no checks run, data kept for 30 days (decision D8). */
export function tenantSuspendedPage(accountUrl: string): Response {
  return page({
    status: 503,
    title: "This OpenPing is paused",
    badge: { text: "Paused", tone: "suspended" },
    body: [
      "Its monitors aren't being checked and its status page is offline for now.",
      "If it's yours, sign in to your account to restore it. Your monitors and history are kept for 30 days.",
    ],
    action: { href: accountUrl, label: "Sign in to your account" },
  });
}

/** The tenant is still being provisioned. */
export function tenantProvisioningPage(): Response {
  return page({
    status: 503,
    title: "Almost ready",
    badge: { text: "Setting up", tone: "degraded" },
    body: ["This OpenPing is still being set up. It usually takes less than a minute; reload this page shortly."],
    headers: { "retry-after": "10" },
  });
}

/** The tenant should be there but couldn't be reached. */
export function tenantUnavailablePage(): Response {
  return page({
    status: 502,
    title: "This OpenPing can't be reached right now",
    badge: { text: "Unavailable", tone: "degraded" },
    body: ["Something went wrong on our side. It has been logged; please try again in a minute."],
    headers: { "retry-after": "30" },
  });
}

/** A host the platform doesn't serve. */
export function unknownHostPage(): Response {
  return page({
    status: 404,
    title: "Page not found",
    body: ["This address isn't part of OpenPing Hosted."],
  });
}

/** A path on app.<domain> that doesn't exist. */
export function appNotFoundPage(appUrl: string): Response {
  return page({
    status: 404,
    title: "Page not found",
    body: ["There's nothing at this address."],
    action: { href: appUrl, label: "Go to OpenPing Hosted" },
  });
}

/** app.<domain> until sign-up (B2) exists. */
export function appHomePage(): Response {
  return page({
    status: 200,
    title: "OpenPing Hosted is coming soon",
    body: [
      "Uptime monitoring and a status page, run for you: 20 monitors, 2 status pages and every alert channel for $24 a year.",
      'Join the waitlist on <a href="https://openping.n8builds.dev/#pricing">openping.n8builds.dev</a> to hear when it opens.',
    ],
  });
}
