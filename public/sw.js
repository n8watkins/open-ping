/*
 * OpenPing service worker (PRD §14).
 * Plain JS served statically from /public (NOT bundled by Vite).
 *
 * - The app shell works offline: navigations fall back to the last shell, then
 *   to /offline.
 * - The last /api/overview and /api/overview/history answers are kept, so the
 *   installed app opens on a train with the last known status. No other API
 *   response is ever stored.
 * - Web Push: shows alerts, and a tap opens the incident in the app.
 *
 * Change VERSION whenever this file's caching changes: the new worker then
 * installs, takes over open tabs and drops the old shell cache.
 */
const VERSION = "v2";
const SHELL_CACHE = `openping-shell-${VERSION}`;
// Keep in step with src/client/lib/offline.ts (its test checks).
const API_CACHE = "openping-api-v1";
const API_CACHE_MESSAGE = "openping:api-cache";
const CACHEABLE_API_PATHS = ["/api/overview", "/api/overview/history"];
const SAVED_AT_HEADER = "x-openping-saved-at";
const PRECACHE_MESSAGE = "openping:precache";
const PRECACHE_LIST = "/sw-precache.json";
const STATIC_FILE = /\.(png|svg|ico|webp|jpg|jpeg|woff2|webmanifest)$/;

const SHELL = [
  "/",
  "/offline",
  "/favicon.svg",
  "/icon.svg",
  "/icon-192.png",
  "/badge-96.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, API_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Save every bundle of the current build (the signed-in app asks, once per
 * load), and drop bundles of earlier builds. Offline or on any error it does
 * nothing: what is saved stays.
 */
async function precacheApp() {
  let files;
  try {
    const res = await fetch(PRECACHE_LIST, { cache: "no-store" });
    if (!res.ok) return;
    files = (await res.json()).files;
  } catch {
    return;
  }
  if (!Array.isArray(files)) return;
  const wanted = new Set(files.filter((f) => typeof f === "string" && f.startsWith("/assets/")));
  const cache = await caches.open(SHELL_CACHE);
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !wanted.has(path)) await cache.delete(request);
  }
  await Promise.allSettled(
    [...wanted].map(async (path) => {
      if (!(await cache.match(path))) await cache.add(path);
    }),
  );
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === PRECACHE_MESSAGE) event.waitUntil(precacheApp());
});

// Dynamic endpoints are never cached: always the network.
function isPassthrough(url) {
  return (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/auth" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/hb" ||
    url.pathname.startsWith("/hb/") ||
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/mcp/")
  );
}

function isCacheableApi(url) {
  return url.origin === self.location.origin && CACHEABLE_API_PATHS.includes(url.pathname);
}

/**
 * Pages whose HTML is the app shell, so a fresh copy can replace the saved
 * one. /embed has its own framing policy and /offline is a static page.
 */
function isShellNavigation(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return !(p === "/embed" || p.startsWith("/embed/") || p === "/offline" || p.includes("."));
}

/** Tell the page that asked whether its Overview data is live or saved. */
async function tell(clientId, message) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage({ type: API_CACHE_MESSAGE, ...message });
}

/**
 * Network first; on success save a copy stamped with the time. On a network
 * failure answer with the saved copy. A signed-out answer (401/403) forgets
 * everything saved, so the data never outlives the session.
 */
async function overviewNetworkFirst(event) {
  const { request } = event;
  const cache = await caches.open(API_CACHE);
  let fresh;
  try {
    fresh = await fetch(request);
  } catch {
    const saved = await cache.match(request);
    if (!saved) return Response.error();
    const savedAt = Number(saved.headers.get(SAVED_AT_HEADER)) || undefined;
    event.waitUntil(tell(event.clientId, { source: "cached", savedAt }));
    return saved;
  }
  if (fresh.status === 401 || fresh.status === 403) {
    event.waitUntil(caches.delete(API_CACHE));
  } else if (fresh.ok && fresh.type === "basic") {
    const copy = fresh.clone();
    event.waitUntil(
      (async () => {
        const headers = new Headers(copy.headers);
        headers.set(SAVED_AT_HEADER, String(Date.now()));
        const body = await copy.arrayBuffer();
        await cache.put(request, new Response(body, { status: copy.status, statusText: copy.statusText, headers }));
      })(),
    );
    event.waitUntil(tell(event.clientId, { source: "fresh" }));
  }
  return fresh;
}

async function navigationNetworkFirst(event) {
  const { request } = event;
  const url = new URL(request.url);
  try {
    const fresh = await fetch(request);
    // Keep the saved shell in step with the deployed build, so offline it
    // loads the same hashed bundles the last visit did.
    if (fresh.ok && !fresh.redirected && fresh.type === "basic" && isShellNavigation(url)) {
      const copy = fresh.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put("/", copy)));
    }
    return fresh;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    if (isShellNavigation(url)) {
      const shell = await cache.match("/");
      if (shell) return shell;
    }
    return (await cache.match("/offline")) || Response.error();
  }
}

/** Hashed bundles never change: cache first. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok && fresh.type === "basic") {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, fresh.clone());
  }
  return fresh;
}

/** Other static files (icons, manifest): saved copy now, refreshed behind it. */
async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (fresh) => {
      if (fresh.ok && fresh.type === "basic") await cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle GET; let everything else go straight to the network.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isCacheableApi(url)) {
    event.respondWith(overviewNetworkFirst(event));
    return;
  }

  // Passthrough for every other dynamic endpoint (no caching at all).
  if (isPassthrough(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(event));
    return;
  }

  // Only manage same-origin files beyond this point.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Icons, images and the manifest; anything else (feeds, badges, the widget's
  // data) stays on the network.
  if (STATIC_FILE.test(url.pathname)) event.respondWith(staleWhileRevalidate(event));
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {};
      }

      const { title, body, url, tag } = payload || {};
      await self.registration.showNotification(title || "OpenPing", {
        body: body || "",
        tag: tag,
        data: { url: url },
        icon: "/icon-192.png",
        // Android draws the badge from its alpha channel: a white glyph.
        badge: "/badge-96.png",
      });
    })(),
  );
});

/**
 * Where a tapped alert goes: its path on this install. The alert's link may
 * name another address for the same install (APP_URL against workers.dev), and
 * the installed app only opens addresses inside its own scope.
 */
function notificationTarget(rawUrl) {
  const scope = new URL(self.registration.scope);
  if (!rawUrl) return scope.href;
  try {
    const link = new URL(rawUrl, scope);
    const target = new URL(link.pathname + link.search + link.hash, scope);
    return target.href.startsWith(scope.href) ? target.href : scope.href;
  } catch {
    return scope.href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = notificationTarget((event.notification.data || {}).url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const ours = windows.filter((client) => client.url.startsWith(self.registration.scope));

      // Already showing it: just bring it forward.
      const exact = ours.find((client) => client.url === target);
      if (exact) return exact.focus();

      // Otherwise reuse an open OpenPing window (the installed app, when it is
      // open), and move it to the incident.
      const existing = ours.find((client) => client.focused) || ours[0];
      if (existing) {
        const focused = await existing.focus();
        try {
          const moved = await (focused || existing).navigate(target);
          if (moved) return moved;
        } catch {
          // A window this worker doesn't control can't be navigated.
        }
      }
      // Inside the app's scope, so an installed app opens in its own window.
      return self.clients.openWindow(target);
    })(),
  );
});
