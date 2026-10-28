import type { EventName } from "../../shared/events";

/**
 * Count one landing page event (src/worker/routes/events.ts). Fire and forget:
 * it never throws, never delays a click, and sends each name at most once per
 * page load, which keeps database writes to a minimum. No cookies or ids are
 * sent; the server keeps only a daily total per name.
 *
 * Call it only on a HOME_PAGE="landing" install (the landing page itself, or
 * where lib/home.ts isLandingInstall says so); elsewhere the server answers 404.
 */
/** The events the page sends; the Worker counts `signin_not_admin` itself. */
export type TrackedEvent = Exclude<EventName, "signin_not_admin">;

const sent = new Set<TrackedEvent>();

export function track(name: TrackedEvent): void {
  if (sent.has(name)) return;
  sent.add(name);
  const body = JSON.stringify({ name });
  try {
    // A beacon survives the page navigating away right after a click.
    if (navigator.sendBeacon?.("/api/events", new Blob([body], { type: "text/plain" }))) return;
  } catch {
    // Fall back to fetch below.
  }
  void fetch("/api/events", { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
}
