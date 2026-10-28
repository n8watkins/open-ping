import type { AuthStatus, Me } from "./bootstrap";

/** What `/` renders (App.tsx RootIndex). */
export type RootView = "loading" | "dashboard" | "landing" | "status";

/**
 * Decide what `/` shows, from the bootstrap fetch:
 *  - nothing until it's back, so nobody sees one page and then another;
 *  - the dashboard for a signed-in admin, on every install;
 *  - for anyone else, the HOME_PAGE choice the server reports: OpenPing's
 *    marketing page only where it's "landing" (the canonical install), and
 *    this install's own status page everywhere else, including when the
 *    server couldn't be asked (the status page then says it's unavailable).
 */
export function rootView({
  loading,
  me,
  status,
}: {
  loading: boolean;
  me: Me | null;
  status: AuthStatus | null;
}): RootView {
  if (loading) return "loading";
  if (me?.authenticated) return "dashboard";
  return status?.homePage === "landing" ? "landing" : "status";
}

/** True where OpenPing's marketing page (and its click counts) is this install's home. */
export function isLandingInstall(status: AuthStatus | null): boolean {
  return status?.homePage === "landing";
}
