import { describe, expect, it } from "@effect/vitest";

import { toolGuardEnvironment } from "./toolGuardRuntime.ts";

describe("toolGuardEnvironment", () => {
  it.each([
    ["approval-required", "enforcement"],
    ["auto-accept-edits", "enforcement"],
    ["auto", "enforcement"],
    ["full-access", "shadow"],
  ] as const)("maps %s to Tool Guard %s mode", (runtimeMode, policyMode) => {
    expect(toolGuardEnvironment({ EXISTING: "kept" }, runtimeMode)).toEqual({
      EXISTING: "kept",
      T3RESEARCH_RUNTIME_MODE: runtimeMode,
      T3RESEARCH_TOOL_GUARD_MODE: policyMode,
      T3RESEARCH_TOOL_GUARD_PROFILE: runtimeMode,
    });
  });
});
