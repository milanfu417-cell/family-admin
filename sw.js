// Bump this (and the ?v= query strings in index.html, and SW_VERSION in
// script.js) together on every deploy — it's what forces phones to drop
// their old cached copy instead of showing a stale layout.
const CACHE_NAME = "family-admin-v24";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=24",
  "./script.js?v=24",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Never cache cross-origin requests (the Google Sheets CSV export) — always
  // hit the network so synced calendar data is never served stale.
  if (new URL(request.url).origin !== self.location.origin) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
