import { describe, expect, it } from "vite-plus/test";

import { TOOL_GUARD_MODE_PRESENTATION } from "./toolGuardModes";

describe("Tool Guard runtime modes", () => {
  it("maps the three guarded modes to enforcement", () => {
    expect(TOOL_GUARD_MODE_PRESENTATION["approval-required"].policyMode).toBe("enforcement");
    expect(TOOL_GUARD_MODE_PRESENTATION["auto-accept-edits"].policyMode).toBe("enforcement");
    expect(TOOL_GUARD_MODE_PRESENTATION.auto.policyMode).toBe("enforcement");
  });

  it("keeps full access observable through shadow audit", () => {
    expect(TOOL_GUARD_MODE_PRESENTATION["full-access"]).toMatchObject({
      profile: "full-access",
      policyMode: "shadow",
    });
  });
});
