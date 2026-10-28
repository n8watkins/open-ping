/**
 * Offline, last-known status.
 *
 * The service worker (public/sw.js) keeps the last good /api/overview and
 * /api/overview/history responses. When the network fails it answers with
 * those and tells the page when they were saved; the shell then shows
 * "Offline, showing data from 10:42" instead of an error.
 *
 * The names it shares with public/sw.js live in sw-contract.ts.
 */
import { useSyncExternalStore } from "react";
import { API_CACHE, API_CACHE_MESSAGE, PRECACHE_MESSAGE } from "./sw-contract";

export interface ApiCacheMessage {
  type: typeof API_CACHE_MESSAGE;
  /** "cached": served from the cache; "fresh": the network answered. */
  source: "cached" | "fresh";
  /** When the served response was saved (epoch ms), for "cached". */
  savedAt?: number;
}

export function isApiCacheMessage(data: unknown): data is ApiCacheMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === API_CACHE_MESSAGE &&
    (d.source === "cached" || d.source === "fresh") &&
    (d.savedAt === undefined || (typeof d.savedAt === "number" && Number.isFinite(d.savedAt)))
  );
}

/**
 * The oldest saved time among what's on screen: after a "cached" message the
 * page shows data from then until a "fresh" one says the network is back.
 */
export function nextSavedAt(current: number | null, msg: ApiCacheMessage): number | null {
  if (msg.source === "fresh") return null;
  if (msg.savedAt === undefined) return current;
  return current === null ? msg.savedAt : Math.min(current, msg.savedAt);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "10:42" today, "Oct 27, 10:42" on another day (24-hour, this device's time). */
export function formatSavedAt(savedAt: number, now: number, locale?: string): string {
  const saved = new Date(savedAt);
  const clock = `${pad(saved.getHours())}:${pad(saved.getMinutes())}`;
  if (saved.toDateString() === new Date(now).toDateString()) return clock;
  const day = saved.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return `${day}, ${clock}`;
}

/** The shell's offline banner, or null for none. */
export function offlineBanner({
  online,
  savedAt,
  now,
  locale,
}: {
  online: boolean;
  savedAt: number | null;
  now: number;
  locale?: string;
}): string | null {
  if (savedAt !== null) return `Offline, showing data from ${formatSavedAt(savedAt, now, locale)}`;
  if (!online) return "You're offline, so data may be stale.";
  return null;
}

let savedAt: number | null = null;
const listeners = new Set<() => void>();

function set(next: number | null) {
  if (next === savedAt) return;
  savedAt = next;
  for (const fn of listeners) fn();
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (isApiCacheMessage(event.data)) set(nextSavedAt(savedAt, event.data));
  });
}

/** When the Overview data on screen was saved, or null when it is live. */
export function useSavedAt(): number | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => savedAt,
    () => null,
  );
}

/** Whether the screen is showing saved (offline) data right now. */
export function isShowingSavedData(): boolean {
  return savedAt !== null;
}

/** Whether a saved Overview exists, so the shell can open offline. */
export async function hasSavedOverview(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(API_CACHE);
    return (await cache.match("/api/overview")) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Ask the service worker to save every page of the app, so pages not opened
 * yet still load offline. Only the signed-in shell asks: a visitor to the
 * public status page doesn't download the admin app.
 */
export function precacheApp(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: PRECACHE_MESSAGE }));
}

/** Forget the saved Overview: on sign-out, or when the session has ended. */
export async function clearSavedData(): Promise<void> {
  set(null);
  if (typeof caches === "undefined") return;
  try {
    await caches.delete(API_CACHE);
  } catch {
    // Nothing saved, or storage unavailable.
  }
}
