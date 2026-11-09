import { describe, expect, it } from "@effect/vitest";

import { setToolGuardRuntimeEnabled, toolGuardEnvironment } from "./toolGuardRuntime.ts";

describe("toolGuardEnvironment", () => {
  it.each([
    ["approval-required", "enforcement"],
    ["auto-accept-edits", "enforcement"],
    ["auto", "enforcement"],
    ["full-access", "enforcement"],
  ] as const)("maps %s to Tool Guard %s mode", (runtimeMode, policyMode) => {
    setToolGuardRuntimeEnabled(true);
    expect(toolGuardEnvironment({ EXISTING: "kept" }, runtimeMode)).toEqual({
      EXISTING: "kept",
      T3RESEARCH_RUNTIME_MODE: runtimeMode,
      T3RESEARCH_TOOL_GUARD_MODE: policyMode,
      T3RESEARCH_TOOL_GUARD_PROFILE: runtimeMode,
    });
  });

  it("passes the hook path to providers that call the wrapper themselves", () => {
    setToolGuardRuntimeEnabled(true, "/data/tool-guard/hook");
    expect(toolGuardEnvironment({}, "full-access").T3RESEARCH_TOOL_GUARD_HOOK).toBe(
      "/data/tool-guard/hook",
    );
    setToolGuardRuntimeEnabled(false);
    setToolGuardRuntimeEnabled(true);
    expect(toolGuardEnvironment({}, "full-access").T3RESEARCH_TOOL_GUARD_HOOK).toBeUndefined();
  });

  it("preserves native provider permissions when the integration is disabled", () => {
    setToolGuardRuntimeEnabled(false);
    const environment = { EXISTING: "kept" };
    expect(toolGuardEnvironment(environment, "auto")).toBe(environment);
  });
});
