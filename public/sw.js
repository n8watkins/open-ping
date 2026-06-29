/*
 * OpenPing service worker (PRD §14).
 * Plain JS served statically from /public (NOT bundled by Vite).
 * Provides an offline-capable app shell plus Web Push handling.
 */
const CACHE = "openping-shell-v1";
const SHELL = ["/", "/offline.html", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// Dynamic endpoints must never be cached — always hit the network.
function isPassthrough(url) {
  return (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/auth" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/hb" ||
    url.pathname.startsWith("/hb/")
  );
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

  // Passthrough for dynamic endpoints (no caching at all).
  if (isPassthrough(url)) return;

  // Navigations: network-first, fall back to cached "/" then "/offline.html".
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match("/")) ||
            (await cache.match("/offline.html")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Only manage same-origin assets beyond this point.
  if (url.origin !== self.location.origin) return;

  // Other same-origin GET: cache-first, then network (cache basic 200s).
  event.respondWith(
    (async () => {
      try {
        const cached = await caches.match(request);
        if (cached) return cached;

        const fresh = await fetch(request);
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const fallback = await caches.match(request);
        return fallback || Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
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
        icon: "/icon.svg",
        badge: "/icon.svg",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = data.url || "/";

  event.waitUntil(
    (async () => {
      const target = new URL(targetUrl, self.location.origin);
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of all) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.href === target.href && "focus" in client) {
            return client.focus();
          }
        } catch {
          // Ignore clients with unparsable URLs.
        }
      }

      // No matching client open — fall back to focusing any window, else open one.
      for (const client of all) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target.href);
      }
    })(),
  );
});
