/**
 * The few pages the platform answers with itself, before any customer's
 * OpenPing is involved: no such OpenPing, one that is suspended or still
 * being set up, and the 404 of app.<domain>.
 *
 * Plain HTML with inline CSS and no scripts, in OpenPing's design tokens
 * (src/client/index.css): the dark navy shell by default, and the light
 * palette when the visitor's system asks for it.
 */

import { STYLE, SUPPORT_EMAIL, escapeHtml } from "./ui";

export { SUPPORT_EMAIL, escapeHtml };

const PAGE_STYLE = `${STYLE}
.actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
@media (min-width: 640px) { .actions .button { width: auto; } }
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
    ? `<div class="actions"><a class="button primary" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a></div>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)} - OpenPing</title>
<style>${PAGE_STYLE}</style>
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
