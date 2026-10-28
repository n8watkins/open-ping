import type { Env } from "../types";
import { LANDING_DESCRIPTION, LANDING_TITLE } from "../../shared/landing-meta";

/**
 * What a signed-out visitor sees at `/` (the HOME_PAGE wrangler var).
 *
 * - "status" (the default, and the template's value): this install's own
 *   default public status page, or a short "no public status page" screen
 *   when it's turned off. Every install is its owner's own, so its visitors
 *   never see OpenPing's marketing page.
 * - "landing": the OpenPing marketing page. Only the canonical install
 *   (openping.n8builds.dev) sets it, in its deploy.local.json.
 *
 * Signed-in admins always get the dashboard at `/`, whatever the value.
 */
export type HomePage = "status" | "landing";

export function homePage(env: Pick<Env, "HOME_PAGE">): HomePage {
  return env.HOME_PAGE?.trim().toLowerCase() === "landing" ? "landing" : "status";
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The app shell served at `/` on a landing install, with the landing page's
 * title, description and link-preview tags written in, so a crawler or a chat
 * app's link preview doesn't need to run the app to read them. `origin` is the
 * install's own origin (from the request), so previews point back at it.
 * Pure string work on the small Vite-built index.html.
 */
export function withLandingHead(html: string, origin: string): string {
  const title = escapeAttr(LANDING_TITLE);
  const description = escapeAttr(LANDING_DESCRIPTION);
  const url = escapeAttr(`${origin}/`);
  const image = escapeAttr(`${origin}/landing/app-overview.webp`);
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="OpenPing" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1360" />`,
    `<meta property="og:image:height" content="860" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<link rel="canonical" href="${url}" />`,
  ].join("\n    ");
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${description}" />`,
    )
    .replace(/\s*<\/head>/, `\n    ${tags}\n  </head>`);
}
