import type { Env } from "../types";
import { landingMeta, parseHostedSignupUrl } from "../../shared/hosted-offer";

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

/**
 * The OpenPing Hosted sign-up page (the HOSTED_SIGNUP_URL var), or null while
 * Hosted is a waitlist: unset, blank or not a usable https URL.
 */
export function hostedSignupUrl(env: Pick<Env, "HOSTED_SIGNUP_URL">): string | null {
  return parseHostedSignupUrl(env.HOSTED_SIGNUP_URL);
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
 * install's own origin (from the request), so previews point back at it, and
 * `hostedOpen` picks the launch wording once Hosted takes sign-ups.
 * Pure string work on the small Vite-built index.html.
 */
export function withLandingHead(html: string, origin: string, hostedOpen = false): string {
  const meta = landingMeta(hostedOpen);
  const title = escapeAttr(meta.title);
  const description = escapeAttr(meta.description);
  const url = escapeAttr(`${origin}/`);
  // The 1200x630 share card (n8builds family layout, the Overview page on the right).
  const image = escapeAttr(`${origin}/landing/og-image.png`);
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="OpenPing" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="OpenPing: uptime checks, status pages and alerts, free on your own Cloudflare." />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
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
