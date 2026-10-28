/**
 * Where the old single-page addresses of Settings and "Integrations & API" now
 * live. Settings used to be one long page with #anchors; it is now four
 * sub-pages, and the alert channels moved to /alerts. Old bookmarks, the
 * /recover hand-off (/settings?recovered=1#sign-in) and links from other pages
 * keep working through these maps.
 */

export const SETTINGS_PAGES = ["general", "security", "reports", "system"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** The old Settings #anchors, by the sub-page that now holds them. */
const SETTINGS_ANCHORS: Record<string, SettingsPage> = {
  general: "general",
  "sign-in": "security",
  passkeys: "security",
  encryption: "security",
  sessions: "security",
  reports: "reports",
  "weekly-summary": "reports",
  waitlist: "reports",
  "landing-counts": "reports",
  retention: "system",
  usage: "system",
  diagnostics: "system",
  about: "system",
};

/**
 * The sub-page /settings opens: the one an old #anchor points at, else
 * General. The query string is kept (the passkeys card reads ?recovered=1).
 */
export function settingsTarget(search: string, hash: string): string {
  const anchor = hash.replace(/^#/, "");
  const page = SETTINGS_ANCHORS[anchor] ?? "general";
  return `/settings/${page}${search}`;
}

export const DEVELOPER_PAGES = ["tokens", "mcp", "cli", "webhooks", "embeds"] as const;
export type DeveloperPage = (typeof DEVELOPER_PAGES)[number];

/** /integrations is now /alerts; the search and hash ride along. */
export function alertsTarget(search: string, hash: string): string {
  return `/alerts${search}${hash}`;
}

/**
 * What the app shell keys its page entrance on: the address, except that a
 * page with sub-pages counts as one page (its own layout eases the sub-page
 * in), so switching tabs doesn't replay the whole page's entrance.
 */
export function shellTransitionKey(pathname: string): string {
  const first = pathname.split("/")[1] ?? "";
  if (first === "settings" || first === "developers") return `/${first}`;
  return pathname;
}
