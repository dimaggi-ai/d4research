import { lazy, type ComponentType } from "react";

// React types `lazy` against `ComponentType<any>`; matching that is the only
// way a wrapper stays assignable to it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A deployed build renames its hashed chunks. A tab left open across a deploy
 * still holds the old names, so the first lazily-loaded panel it opens (a file
 * preview, a diff) fetches a chunk the server no longer has and the import
 * rejects — the panel never appears until the user reloads by hand.
 *
 * The tab is simply out of date, and reloading is the fix, so do it: reload
 * once per session on a chunk-load failure. The guard keeps a genuinely broken
 * deployment from looping — a second failure surfaces as a normal error.
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
export function clearChunkReloadGuard(
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
    factory().catch((cause: unknown) => {
      if (shouldReloadForChunkFailure(cause, globalThis.sessionStorage)) {
        globalThis.location.reload();
        // Never settles: the reload replaces this document.
        return new Promise<{ default: T }>(() => {});
      }
      throw cause;
    }),
  );
}
