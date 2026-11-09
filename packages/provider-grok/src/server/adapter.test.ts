import { afterEach, describe, expect, it } from "@effect/vitest";
import { setToolGuardRuntimeEnabled } from "@d4research/shared/toolGuardRuntime";

import { grokToolGuardEnvironment } from "./adapter.ts";

describe("grokToolGuardEnvironment", () => {
  afterEach(() => setToolGuardRuntimeEnabled(false));

  it("blocks review rules only where T3 approves Grok's prompts", () => {
    setToolGuardRuntimeEnabled(true);
    expect(grokToolGuardEnvironment({}, "full-access").T3RESEARCH_TOOL_GUARD_ESCALATE).toBe("deny");
    const supervised = grokToolGuardEnvironment({}, "approval-required");
    expect(supervised.T3RESEARCH_TOOL_GUARD_MODE).toBe("enforcement");
    expect(supervised.T3RESEARCH_TOOL_GUARD_ESCALATE).toBeUndefined();
  });

  it("leaves the environment alone while Tool Guard is off", () => {
    const environment = { EXISTING: "kept" };
    expect(grokToolGuardEnvironment(environment, "full-access")).toBe(environment);
  });
});
