const CACHE_NAME = "mktv-shell-v2";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/mktv-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, cloned)).catch(() => {});
        return response;
      });
    }),
  );
});
