import { describe, expect, it } from "vite-plus/test";

import { stampPwaServiceWorker } from "./pwaServiceWorkerBuild";

describe("stampPwaServiceWorker", () => {
  it("changes the service worker bytes and cache name for every deployment", () => {
    const source = 'const CACHE_NAME = "t3code-static-__T3CODE_BUILD_ID__";';

    expect(stampPwaServiceWorker(source, "build-a")).toContain("t3code-static-build-a");
    expect(stampPwaServiceWorker(source, "build-b")).toContain("t3code-static-build-b");
    expect(stampPwaServiceWorker(source, "build-a")).not.toBe(
      stampPwaServiceWorker(source, "build-b"),
    );
  });

  it("rejects an unstamped source instead of silently shipping a stale worker", () => {
    expect(() => stampPwaServiceWorker("const CACHE_NAME = 'static';", "build-a")).toThrow(
      "placeholder was not found",
    );
  });
});
