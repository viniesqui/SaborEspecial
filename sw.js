const CACHE_NAME     = "ceep-lunch-static-v11";
const API_CACHE_NAME = "ceep-api-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./customer.html",
  "./customer-app.html",
  "./track.html",
  "./admin.html",
  "./helper.html",
  "./deliveries.html",
  "./styles.css",
  "./login.js",
  "./app.js",
  "./track.js",
  "./admin.js",
  "./helper.js",
  "./deliveries.js",
  "./config.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  const KNOWN_CACHES = new Set([CACHE_NAME, API_CACHE_NAME]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (!KNOWN_CACHES.has(key)) {
            return caches.delete(key);
          }
          return Promise.resolve();
        })
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Branch 1: API GET requests — Network-First with Cache Fallback.
  // Only cache ok responses to avoid poisoning with 401/403/500 errors.
  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request, { cacheName: API_CACHE_NAME }))
    );
    return;
  }

  // Branch 2: Static app-shell assets — Network-First (update cache on each fetch).
  const isAppShellAsset = STATIC_ASSETS.some((asset) => requestUrl.pathname.endsWith(asset.replace("./", "/"))) ||
    requestUrl.pathname === "/" ||
    requestUrl.pathname.endsWith("/index.html");

  if (isAppShellAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Branch 3: Everything else — Cache-First.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
