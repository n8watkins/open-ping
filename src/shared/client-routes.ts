/**
 * Every path the React app (src/client/App.tsx) renders a page for. The Worker
 * answers any other path with the app shell and a real 404 status, so React's
 * catch-all NotFound page shows and crawlers and monitors see the 404.
 *
 * `:name` matches one path segment; a trailing `/*` matches anything below.
 * src/shared/client-routes.test.ts checks this list against App.tsx.
 */
export const CLIENT_ROUTES = [
  "/",
  "/login",
  "/setup",
  "/recover",
  "/install",
  "/status",
  "/status/:slug",
  "/embed",
  "/tools",
  "/tools/uptime-calculator",
  "/tools/subnet-calculator",
  "/tools/cron-tester",
  "/tools/dns-lookup",
  "/tools/mx-lookup",
  "/tools/is-it-down",
  "/monitors",
  "/monitors/new",
  "/monitors/:id",
  "/monitors/:id/edit",
  "/incidents",
  "/maintenance",
  "/alerts",
  "/integrations",
  // Unknown sub-pages redirect to the section's first page (App.tsx).
  "/developers",
  "/developers/*",
  "/settings",
  "/settings/*",
  "/status-page",
  "/status-page/new",
  "/status-page/:id",
] as const;

const PATTERNS = CLIENT_ROUTES.map((route) => {
  const body = route
    .replace(/\/\*$/, "")
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(route.endsWith("/*") ? `^${body}/.+$` : `^${body || "/"}$`);
});

/** Whether the React app has a page at `path` (a trailing slash is ignored). */
export function isClientRoute(path: string): boolean {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return PATTERNS.some((pattern) => pattern.test(normalized));
}
