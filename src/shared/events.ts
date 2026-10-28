/**
 * Every landing page event the click counter accepts (src/worker/routes/events.ts),
 * in the order Settings lists them. The page sends the first group itself
 * (src/client/lib/track.ts); the Worker counts `signin_not_admin` when someone
 * who isn't the admin signs in with GitHub.
 */
export const EVENT_NAMES = [
  "landing_view",
  "hero_deploy",
  "hero_waitlist",
  "hero_status",
  "hero_tools",
  "nav_deploy",
  "pricing_view",
  "pricing_deploy",
  "waitlist_join",
  "cta_deploy",
  "cta_waitlist",
  "install_view",
  "signin_open",
  "signin_not_admin",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
