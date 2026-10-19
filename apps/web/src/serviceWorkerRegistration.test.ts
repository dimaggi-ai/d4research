import { describe, expect, it, vi } from "vite-plus/test";
import {
  canRetireServiceWorkerForLocation,
  retireServiceWorker,
} from "./serviceWorkerRegistration";

function browserStub(pathname = "/") {
  const names = new Set(["t3code-static-old", "another-app"]);
  const ours = {
    active: { scriptURL: "https://app.example/service-worker.js" },
    waiting: null,
    installing: null,
    unregister: vi.fn(),
  };
  const other = {
    active: { scriptURL: "https://app.example/other-worker.js" },
    waiting: null,
    installing: null,
    unregister: vi.fn(),
  };
  let registrations = [ours, other];
  ours.unregister.mockImplementation(async () => {
    registrations = registrations.filter((item) => item !== ours);
    return true;
  });
  const reload = vi.fn();
  const register = vi.fn();
  const getRegistrations = vi.fn(async () => registrations);
  const target = {
    navigator: { serviceWorker: { controller: ours.active, register, getRegistrations } },
    location: { hostname: "app.example", href: `https://app.example${pathname}`, reload },
    isSecureContext: true,
    caches: { keys: async () => [...names], delete: async (name: string) => names.delete(name) },
  } as unknown as Window;
  return { target, ours, other, reload, register, names, getRegistrations };
}

describe("retireServiceWorker", () => {
  it("removes only d4's worker and cache, and reloads the controlled page once", async () => {
    const browser = browserStub();
    await retireServiceWorker(browser.target);
    expect(browser.ours.unregister).toHaveBeenCalledOnce();
    expect(browser.other.unregister).not.toHaveBeenCalled();
    expect([...browser.names]).toEqual(["another-app"]);
    expect(browser.reload).toHaveBeenCalledOnce();
    expect(browser.register).not.toHaveBeenCalled();
    await retireServiceWorker(browser.target);
    expect(browser.reload).toHaveBeenCalledOnce();
  });

  it("does not reload a fresh page that has no d4 controller", async () => {
    const browser = browserStub();
    Object.assign(browser.target.navigator.serviceWorker, { controller: null });
    await retireServiceWorker(browser.target);
    expect(browser.reload).not.toHaveBeenCalled();
    expect(browser.register).not.toHaveBeenCalled();
  });

  it("still removes the worker when CacheStorage is unavailable", async () => {
    const browser = browserStub();
    browser.target.caches.keys = () => Promise.reject(new Error("storage blocked"));
    await retireServiceWorker(browser.target);
    expect(browser.ours.unregister).toHaveBeenCalledOnce();
    expect(browser.reload).toHaveBeenCalledOnce();
  });

  it("leaves pairing untouched", async () => {
    const browser = browserStub("/pair#token=single-use");
    await retireServiceWorker(browser.target);
    expect(browser.getRegistrations).not.toHaveBeenCalled();
    expect(browser.reload).not.toHaveBeenCalled();
  });

  it("does not interrupt pairing reached while cleanup is in flight", async () => {
    const browser = browserStub();
    browser.ours.unregister.mockImplementation(async () => {
      browser.target.location.href = "https://app.example/pair#token=single-use";
      return true;
    });
    await retireServiceWorker(browser.target);
    expect(browser.reload).not.toHaveBeenCalled();
  });

  it("keeps the app usable when registration access fails", async () => {
    const browser = browserStub();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      browser.getRegistrations.mockRejectedValue(new Error("storage blocked"));
      await expect(retireServiceWorker(browser.target)).resolves.toBeUndefined();
      expect(browser.reload).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});

describe("canRetireServiceWorkerForLocation", () => {
  it("allows normal app routes", () => {
    expect(canRetireServiceWorkerForLocation(new URL("https://app.example/"))).toBe(true);
  });
  it("excludes pairing routes and tokens", () => {
    for (const path of ["/pair", "/pair/", "/#token=ABC123"]) {
      expect(canRetireServiceWorkerForLocation(new URL(`https://app.example${path}`))).toBe(false);
    }
  });
});
