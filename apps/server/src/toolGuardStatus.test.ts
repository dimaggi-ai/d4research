import { describe, expect, it } from "vite-plus/test";

import { classifyToolGuardIntegration } from "./toolGuardStatus.ts";

describe("Tool Guard integration status", () => {
  it("does not claim lifecycle ownership without an installation manifest", () => {
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: true,
        managedHookDetected: true,
        externalHookDetected: true,
      }),
    ).toBe("external");
  });

  it("reports an external hook instead of installing a duplicate", () => {
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: true,
        managedHookDetected: false,
        externalHookDetected: true,
      }),
    ).toBe("external");
  });

  it("reports availability separately from hook installation", () => {
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: true,
        managedHookDetected: false,
        externalHookDetected: false,
      }),
    ).toBe("available");
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: false,
        managedHookDetected: false,
        externalHookDetected: true,
      }),
    ).toBe("external");
  });

  it("distinguishes an installed but disabled integration", () => {
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: true,
        managedHookDetected: false,
        externalHookDetected: false,
        installed: true,
        enabled: false,
      }),
    ).toBe("disabled");
  });
});
