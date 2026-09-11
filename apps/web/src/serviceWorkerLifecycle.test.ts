// @effect-diagnostics nodeBuiltinImport:off - Executes the shipped worker in an isolated browser-global fixture.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

describe("PWA cache retirement", () => {
  it("activates without network access and removes only d4's stale asset caches", async () => {
    const cacheNames = new Set(["t3code-static-old", "t3code-static-older", "another-app-cache"]);
    const listeners = new Map<
      string,
      (event: { waitUntil: (work: Promise<unknown>) => void }) => void
    >();
    const skipWaiting = vi.fn();
    const claim = vi.fn(() => {
      expect([...cacheNames]).toEqual(["another-app-cache"]);
      return Promise.resolve();
    });
    const fetch = vi.fn(() => Promise.reject(new Error("offline")));
    const unregister = vi.fn().mockResolvedValue(true);
    NodeVM.runInNewContext(source, {
      self: {
        addEventListener: (
          type: string,
          listener: (event: { waitUntil: (work: Promise<unknown>) => void }) => void,
        ) => listeners.set(type, listener),
        skipWaiting,
        clients: { claim },
        registration: { unregister },
      },
      caches: {
        keys: () => Promise.resolve([...cacheNames]),
        delete: (name: string) => Promise.resolve(cacheNames.delete(name)),
      },
      fetch,
    });
    let activation: Promise<unknown> | undefined;
    const event = {
      waitUntil: (work: Promise<unknown>) => {
        activation = work;
      },
    };
    listeners.get("install")!(event);
    expect(skipWaiting).toHaveBeenCalledOnce();
    listeners.get("activate")!(event);
    await activation;
    expect(claim).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(listeners.has("fetch")).toBe(false);
  });
});
