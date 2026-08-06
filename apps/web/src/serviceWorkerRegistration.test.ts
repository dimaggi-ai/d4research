import { describe, expect, it } from "vite-plus/test";

import { shouldRegisterServiceWorkerForLocation } from "./serviceWorkerRegistration";

describe("shouldRegisterServiceWorkerForLocation", () => {
  it("registers on ordinary app routes", () => {
    expect(shouldRegisterServiceWorkerForLocation(new URL("https://app.example/"))).toBe(true);
    expect(
      shouldRegisterServiceWorkerForLocation(new URL("https://app.example/settings/general")),
    ).toBe(true);
  });

  it("skips the pairing surface", () => {
    expect(shouldRegisterServiceWorkerForLocation(new URL("https://app.example/pair"))).toBe(false);
    expect(shouldRegisterServiceWorkerForLocation(new URL("https://app.example/pair/"))).toBe(
      false,
    );
  });

  it("skips any URL still carrying a pairing token", () => {
    expect(
      shouldRegisterServiceWorkerForLocation(new URL("https://app.example/#token=ABC123")),
    ).toBe(false);
  });
});
