// Build: __T3CODE_BUILD_ID__
// Retire the old asset cache without uninstalling the PWA. This app needs its
// server; the browser's HTTP cache already handles immutable hashed assets.
// In particular, never cache login redirects or intercept document fetches.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("t3code-static-"))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister()),
  );
});
