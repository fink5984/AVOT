/*
 * Service worker of the warehouse handheld (/scanner). Its only job is to let
 * the scanner page open again without a network connection. It never caches
 * API responses: scans are queued by the page itself in IndexedDB and synced
 * with idempotent op ids, so nothing here can make an offline scan look saved.
 */
const CACHE = "avot-scanner-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/scanner", "/scanner.webmanifest", "/scanner-icon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // immutable build assets: cache first
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ??
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          }),
      ),
    );
    return;
  }
  // the scanner page: network first (fresh session / build), cached copy when offline
  if (url.pathname === "/scanner") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/scanner", copy));
          }
          return res;
        })
        .catch(() => caches.match("/scanner")),
    );
  }
});
