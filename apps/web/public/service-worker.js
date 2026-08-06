// Replaced with a unique value by the production build. A byte-identical
// worker never activates, leaving installed iOS/iPadOS PWAs on an old bundle.
const CACHE_NAME = "t3code-static-__T3CODE_BUILD_ID__";
const APP_SHELL = ["/manifest.webmanifest", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

// Backend traffic must never be mediated by the worker: none of it is
// cacheable, and interception turned recoverable network failures into opaque
// ones (a failed API fetch resolved to `undefined`). Kept in sync with
// DEV_PROXIED_PATH_PREFIXES in packages/shared/src/devProxy.ts.
const BACKEND_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws"];

function isBackendPath(pathname) {
  return BACKEND_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (isBackendPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (
            response.ok &&
            (url.pathname.startsWith("/assets/") || APP_SHELL.includes(url.pathname))
          ) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch((cause) => {
          // Only substitute a cached copy when one exists; otherwise let the
          // failure surface so the page can retry or report it.
          if (cached) return cached;
          throw cause;
        });
      return cached ?? network;
    }),
  );
});
