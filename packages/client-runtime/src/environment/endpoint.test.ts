import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, normalizeHttpBaseUrl, environmentEndpointUrl } from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});

describe("shared environment API paths", () => {
  it("keeps gateway paths for descriptor, preview, device and authentication requests", () => {
    const gateway = "https://mac.test/api/shared-environments/proxy/mini";
    for (const path of [
      "/.well-known/t3/environment",
      "/api/preview-stream",
      "/api/device-hub",
      "/api/auth/session",
    ]) {
      expect(environmentEndpointUrl(gateway, path)).toBe(gateway + path);
      expect(environmentEndpointUrl("https://mini.test/ignored?x=1#fragment", path)).toBe(
        "https://mini.test" + path,
      );
    }
  });
});
