import { describe, expect, it } from "vite-plus/test";

import { classifyToolGuardIntegration } from "./toolGuardStatus.ts";

describe("Tool Guard integration status", () => {
  it("prefers the d2research-managed hook over an external hook", () => {
    expect(
      classifyToolGuardIntegration({
        binaryAvailable: true,
        managedHookDetected: true,
        externalHookDetected: true,
      }),
    ).toBe("managed");
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
        managedHookDetected: true,
        externalHookDetected: true,
      }),
    ).toBe("unavailable");
  });
});
