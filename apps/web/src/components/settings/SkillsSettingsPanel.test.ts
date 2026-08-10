import { describe, expect, it } from "vite-plus/test";

import { canEnableSkillForAllChats } from "./SkillsSettingsPanel";

describe("canEnableSkillForAllChats", () => {
  it("offers the global switch only for user-level skills", () => {
    expect(canEnableSkillForAllChats({ kind: "skill", scope: "user" })).toBe(true);
    expect(canEnableSkillForAllChats({ kind: "skill", scope: "project" })).toBe(false);
    expect(canEnableSkillForAllChats({ kind: "command", scope: "user" })).toBe(false);
  });
});
