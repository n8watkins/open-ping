/**
 * The marketing landing page's title and description. The Worker writes them
 * into the HTML it serves at `/` on a HOME_PAGE="landing" install
 * (src/worker/lib/home-page.ts), and the page sets the same values once it
 * renders, so crawlers and link previews read the same thing either way.
 */
export const LANDING_TITLE = "OpenPing: uptime monitoring on your own Cloudflare";

export const LANDING_DESCRIPTION =
  "Open-source uptime checks, status pages and alerts with schedules that know when an app is meant to be asleep. " +
  "Free in your own Cloudflare account, or join the waitlist for OpenPing Hosted.";

/** The generic description in index.html, for every page that sets no other. */
export const DEFAULT_DESCRIPTION =
  "OpenPing: uptime monitoring and status pages that run in your own Cloudflare account.";
