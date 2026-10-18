// Split chunks are fetched lazily, so a deploy (or desktop server swap) between
// page load and a later fetch can 404 the old hashed assets. One reload picks
// up the fresh index.html.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";

export function installChunkLoadRecovery(
  target: EventTarget = window,
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): () => void {
  const onPreloadError = (event: Event) => {
    if (reloadOnceForChunkLoadError(getStorage, reload)) event.preventDefault();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * failure streak and returns whether it did, so the caller knows whether to
 * swallow the event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {}
}
