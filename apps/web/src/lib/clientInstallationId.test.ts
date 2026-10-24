import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getStableClientId } from "./clientInstallationId";

afterEach(() => vi.unstubAllGlobals());

describe("client installation identity", () => {
  it("shares one persisted identifier across callers", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const first = getStableClientId();
    expect(first).toBeTruthy();
    expect(first!.length).toBeLessThanOrEqual(128);
    expect(getStableClientId()).toBe(first);
  });

  it.each(["x".repeat(129), "ephemeral-browser-client", "   ", " padded "])(
    "replaces an unusable stored identity",
    (stored) => {
      let value = stored;
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => value,
          setItem: (_key: string, next: string) => {
            value = next;
          },
        },
      });
      const clientId = getStableClientId();
      expect(clientId).not.toBe(stored);
      expect(clientId).toHaveLength(36);
    },
  );

  it("does not provide a shared fallback when storage fails", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("storage denied");
      },
    });
    expect(getStableClientId()).toBeNull();
  });

  it("does not claim persistence when storage ignores writes", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => {} } });
    expect(getStableClientId()).toBeNull();
  });
});
