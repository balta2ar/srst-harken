const CACHE = "srst-offline-v4";
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/db.js",
  "/api.js",
  "/timeline.js",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // /api/* is online-only: never cache, never serve from cache.
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  // Stale-while-revalidate: serve cache instantly, refresh it in the background
  // so the next load picks up new shell code without a manual cache-version bump.
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const fetching = fetch(e.request)
          .then((res) => {
            if (res && res.ok && res.type === "basic") cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || fetching;
      })
    )
  );
});
