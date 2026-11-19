/* NityHub service worker - caching hierarchy (blueprint 7.5) and Web Push.
 *
 *   Static assets (JS, CSS, fonts, images) ... CacheFirst
 *   Public pages (storefronts, home) ......... StaleWhileRevalidate
 *   Public catalog & availability APIs ....... NetworkFirst, cache fallback
 *   Wallet, orders, payments, repair, admin .. NetworkOnly (never cached)
 *
 * Anything carrying an Authorization header is per-user and is never touched.
 */

const VERSION = "v2";
const STATIC_CACHE = `nityhub-static-${VERSION}`;
const PAGE_CACHE = `nityhub-pages-${VERSION}`;
const CATALOG_CACHE = `nityhub-catalog-${VERSION}`;
const KEEP = [STATIC_CACHE, PAGE_CACHE, CATALOG_CACHE];

const SENSITIVE = /(?:wallet|order|receipt|payment|repair|transaction|deposit|checkout|profile|dashboard|admin|auth|account|afa|\/me\/|events|notifications|webhook)/i;
const PUBLIC_API = /^\/api\/(?:packages\/[^/]+|storefronts\/[^/]+(?:\/packages\/[^/]+)?|network-availability|banners|social-proof\/deliveries)$/;
const STATIC_ASSET = /\.(?:png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf)$/i;
const PUBLIC_PAGE = /^\/(?:store\/[a-z0-9-]+)?$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("nityhub-") && !KEEP.includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CATALOG_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const saved = await cache.match(request);
    if (saved) return saved;
    throw error;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(PAGE_CACHE);
  const saved = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") await cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);
  if (saved) {
    event.waitUntil(refresh);
    return saved;
  }
  const fresh = await refresh;
  return fresh || offlinePage();
}

function offlinePage() {
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>Offline</title><body style='font-family:system-ui;padding:2rem;color:#0d1b15;background:#f5f7f6'>" +
      "<h1 style='font-size:1.25rem'>You're offline</h1><p>Reconnect to continue. Your orders and wallet are safe.</p></body>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("authorization") || request.cache === "no-store") return;
  const url = new URL(request.url);
  const path = url.pathname;
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && path.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (SENSITIVE.test(path) || request.headers.get("accept")?.includes("text/event-stream")) return;
  if (sameOrigin && STATIC_ASSET.test(path)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (PUBLIC_API.test(path)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (sameOrigin && request.mode === "navigate" && PUBLIC_PAGE.test(path) && !url.search) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/* -------------------------------- Web Push -------------------------------- */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { notification: { title: "NityHub", body: event.data ? event.data.text() : "" } };
  }
  const note = payload.notification || {};
  const data = payload.data || {};
  const title = note.title || data.title || "NityHub";
  const url = (payload.fcmOptions && payload.fcmOptions.link) || data.url || "/dashboard";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: note.body || data.body || "",
      icon: note.icon || "/icon.png",
      badge: "/icon.png",
      tag: data.id || undefined,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/dashboard", self.location.origin);
  // Only ever open our own origin from a notification.
  const href = target.origin === self.location.origin ? target.href : self.location.origin + "/dashboard";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(href).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(href);
  })());
});
