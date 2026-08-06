import { describe, expect, it } from "vite-plus/test";

import {
  CHUNK_RELOAD_STORAGE_KEY,
  isChunkLoadFailure,
  shouldReloadForChunkFailure,
} from "./lazyWithReload";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

describe("isChunkLoadFailure", () => {
  it("recognizes the browser's chunk-load messages", () => {
    expect(
      isChunkLoadFailure(
        new Error("Failed to fetch dynamically imported module: https://host/assets/Panel-x.js"),
      ),
    ).toBe(true);
    expect(
      isChunkLoadFailure(
        new Error(
          'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
        ),
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isChunkLoadFailure(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
  });
});

describe("shouldReloadForChunkFailure", () => {
  it("reloads once, then reports the failure instead of looping", () => {
    const storage = memoryStorage();
    const cause = new Error("Failed to fetch dynamically imported module: /assets/Panel.js");
    expect(shouldReloadForChunkFailure(cause, storage)).toBe(true);
    expect(storage.values.get(CHUNK_RELOAD_STORAGE_KEY)).toBe("1");
    expect(shouldReloadForChunkFailure(cause, storage)).toBe(false);
  });

  it("does not reload for an unrelated error", () => {
    const storage = memoryStorage();
    expect(shouldReloadForChunkFailure(new Error("boom"), storage)).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it("does not reload without usable storage — the loop guard lives there", () => {
    const cause = new Error("Failed to fetch dynamically imported module: /assets/Panel.js");
    expect(shouldReloadForChunkFailure(cause, undefined)).toBe(false);
    expect(
      shouldReloadForChunkFailure(cause, {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });
});
