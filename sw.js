const CACHE_NAME = "ceep-lunch-static-v11";
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
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
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
