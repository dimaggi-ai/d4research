import { getPairingTokenFromUrl } from "./pairingUrl";

export function canRetireServiceWorkerForLocation(url: URL): boolean {
  if (url.pathname === "/pair" || url.pathname === "/pair/") return false;
  return (getPairingTokenFromUrl(url) ?? "").trim().length === 0;
}

/** Remove only our legacy worker/cache, without clearing credentials or drafts. */
export async function retireServiceWorker(target: Window = window): Promise<void> {
  const { navigator, location } = target;
  if (
    !("serviceWorker" in navigator) ||
    !(target.isSecureContext || location.hostname === "localhost") ||
    !canRetireServiceWorkerForLocation(new URL(location.href))
  )
    return;

  const isOurWorker = (worker: ServiceWorker | null) =>
    worker?.scriptURL === new URL("/service-worker.js", location.href).href;
  try {
    const controlled = isOurWorker(navigator.serviceWorker.controller);
    const registrations = await navigator.serviceWorker.getRegistrations();
    const owned = registrations.filter((registration) =>
      [registration.active, registration.waiting, registration.installing].some(isOurWorker),
    );
    const removed = await Promise.all(owned.map((registration) => registration.unregister()));
    // A blocked CacheStorage must not prevent removal of the fetch interceptor.
    try {
      const names = await target.caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("t3code-static-"))
          .map((name) => target.caches.delete(name)),
      );
    } catch {
      // CacheStorage is optional; no new worker will read these caches.
    }
    if (
      controlled &&
      removed.some(Boolean) &&
      canRetireServiceWorkerForLocation(new URL(location.href))
    ) {
      location.reload();
    }
  } catch (cause) {
    console.warn("Legacy service worker cleanup skipped.", cause);
  }
}
