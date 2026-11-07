import { lazy, type ComponentType } from "react";

// React types `lazy` against `ComponentType<any>`; matching that is the only
// way a wrapper stays assignable to it.
type Any = any;

/**
 * Deployments invalidate old hashed chunk URLs held by open tabs. Reload once
 * on a chunk-load failure; a session guard prevents broken deployments from
 * causing a reload loop.
 */
export const CHUNK_RELOAD_STORAGE_KEY = "t3code:chunk-reload-attempted:v1";

const CHUNK_LOAD_FAILURE_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "expected a javascript-or-wasm module script",
  "importing a module script failed",
];

export function isChunkLoadFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  const normalized = message.toLowerCase();
  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function shouldReloadForChunkFailure(
  cause: unknown,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): boolean {
  if (!isChunkLoadFailure(cause) || !storage) {
    return false;
  }
  try {
    if (storage.getItem(CHUNK_RELOAD_STORAGE_KEY)) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, "1");
    return true;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Without it
    // the loop guard is gone, so do not reload.
    return false;
  }
}

/** Clears the guard so a later deploy can recover the same way. */
function clearChunkReloadGuard(
  storage: Pick<Storage, "removeItem"> | undefined = globalThis.sessionStorage,
): void {
  try {
    storage?.removeItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * `React.lazy`, but a chunk that went missing across a deploy reloads the tab
 * onto the current build instead of leaving a panel that never opens.
 */
export function lazyWithReload<T extends ComponentType<Any>>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  return lazy(() =>
    factory().then(
      (loaded) => {
        // A successful load means this build's chunks resolve — re-arm the
        // guard so the *next* deploy can recover the same way. Without this,
        // one recovery would consume the guard for the tab's whole lifetime.
        clearChunkReloadGuard();
        return loaded;
      },
      (cause: unknown) => {
        if (shouldReloadForChunkFailure(cause, globalThis.sessionStorage)) {
          globalThis.location.reload();
          // Never settles: the reload replaces this document.
          return new Promise<{ default: T }>(() => {});
        }
        throw cause;
      },
    ),
  );
}
