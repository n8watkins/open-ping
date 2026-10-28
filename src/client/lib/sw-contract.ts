/**
 * What the page and public/sw.js (plain JS, which can't import this) agree on.
 * src/pwa-files.test.ts checks sw.js uses the same values.
 */

/** The Cache Storage bucket that holds the saved Overview responses. */
export const API_CACHE = "openping-api-v1";
/** The message type the service worker posts about those responses. */
export const API_CACHE_MESSAGE = "openping:api-cache";
/** Asks the service worker to save the app's bundles (sent by the signed-in shell). */
export const PRECACHE_MESSAGE = "openping:precache";
/** The build's list of those bundles (vite.config.ts writes it). */
export const PRECACHE_LIST = "/sw-precache.json";
/** The only API paths the service worker may save (exact pathnames, any query). */
export const CACHEABLE_API_PATHS = ["/api/overview", "/api/overview/history"] as const;
