import { landingMeta } from "./hosted-offer";

/**
 * The marketing landing page's title and description while Hosted is a
 * waitlist. The Worker writes the right pair into the HTML it serves at `/` on
 * a HOME_PAGE="landing" install (src/worker/lib/home-page.ts), and the page sets
 * the same values once it renders, so crawlers and link previews read the same
 * thing either way. Once Hosted opens (HOSTED_SIGNUP_URL), both use
 * `landingMeta(true)` from ./hosted-offer instead.
 */
export const { title: LANDING_TITLE, description: LANDING_DESCRIPTION } = landingMeta(false);

/** The generic description in index.html, for every page that sets no other. */
export const DEFAULT_DESCRIPTION =
  "OpenPing: uptime monitoring and status pages that run in your own Cloudflare account.";
