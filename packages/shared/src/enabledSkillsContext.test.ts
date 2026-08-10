import { describe, expect, it } from "vite-plus/test";

import {
  appendEnabledSkillsContext,
  extractTrailingEnabledSkillsContext,
  mergeEnabledSkillNames,
  setEnabledSkillsForThread,
} from "./enabledSkillsContext.ts";

describe("enabled skills context", () => {
  const skills = [
    {
      name: "focus-mode",
      path: "/home/test/.agents/skills/focus-mode/SKILL.md",
      description: "Keep work focused.",
    },
    {
      name: "security-review",
      path: "/workspace/.agents/skills/security-review/SKILL.md",
    },
  ];

  it("round-trips the exact enabled names while keeping the paths model-readable", () => {
    const prompt = appendEnabledSkillsContext("Fix the bug", skills);
    const extracted = extractTrailingEnabledSkillsContext(prompt);

    expect(extracted).toEqual({
      promptText: "Fix the bug",
      skills: ["focus-mode", "security-review"],
      globalSkills: ["focus-mode", "security-review"],
      sessionSkills: [],
    });
    expect(prompt).toContain(skills[0]!.path);
    expect(prompt).toContain("Read every listed SKILL.md before acting");
  });

  it("replaces an existing server block instead of charging twice on a retry", () => {
    const first = appendEnabledSkillsContext("Run tests", skills);
    const second = appendEnabledSkillsContext(first, [skills[1]!]);

    expect(second.match(/<enabled_skills/gu)).toHaveLength(1);
    expect(extractTrailingEnabledSkillsContext(second)).toEqual({
      promptText: "Run tests",
      skills: ["security-review"],
      globalSkills: ["security-review"],
      sessionSkills: [],
    });
  });

  it("leaves malformed tags and ordinary prose untouched", () => {
    for (const prompt of [
      "What does <enabled_skills> mean?",
      '<enabled_skills version="1" names="not-json">\nbody\n</enabled_skills>',
      '<enabled_skills version="1" names="%5B%22x%22%5D">not trailing</enabled_skills> after',
    ]) {
      expect(extractTrailingEnabledSkillsContext(prompt)).toEqual({
        promptText: prompt,
        skills: [],
        globalSkills: [],
        sessionSkills: [],
      });
    }
  });

  it("deduplicates names and strips a valid block when the setting is disabled", () => {
    const duplicate = appendEnabledSkillsContext("Prompt", [skills[0]!, skills[0]!]);
    expect(extractTrailingEnabledSkillsContext(duplicate).skills).toEqual(["focus-mode"]);
    expect(appendEnabledSkillsContext(duplicate, [])).toBe("Prompt");
  });

  it("round-trips global and chat scopes without duplicating a global skill", () => {
    const prompt = appendEnabledSkillsContext("Review", [
      skills[0]!,
      { ...skills[1]!, scope: "session" },
      { ...skills[0]!, scope: "session" },
    ]);

    expect(extractTrailingEnabledSkillsContext(prompt)).toEqual({
      promptText: "Review",
      skills: ["focus-mode", "security-review"],
      globalSkills: ["focus-mode"],
      sessionSkills: ["security-review"],
    });
    expect(prompt).toContain('"focus-mode" (all chats)');
    expect(prompt).toContain('"security-review" (this chat)');
  });

  it("reads persisted version-one blocks as global skills", () => {
    const encoded = encodeURIComponent(JSON.stringify(["legacy"]));
    const prompt = `Task\n\n<enabled_skills version="1" names="${encoded}">\nbody\n</enabled_skills>`;
    expect(extractTrailingEnabledSkillsContext(prompt)).toEqual({
      promptText: "Task",
      skills: ["legacy"],
      globalSkills: ["legacy"],
      sessionSkills: [],
    });
  });

  it("merges global before chat names, deduplicates, and caps the context tax", () => {
    expect(mergeEnabledSkillNames(["global", "shared"], ["shared", "chat"])).toEqual([
      "global",
      "shared",
      "chat",
    ]);
    expect(
      mergeEnabledSkillNames(
        Array.from({ length: 10 }, (_, index) => `global-${index}`),
        Array.from({ length: 10 }, (_, index) => `chat-${index}`),
      ),
    ).toHaveLength(12);
  });

  it("updates, deletes, bounds, and isolates chat selections", () => {
    const selected = setEnabledSkillsForThread({}, "thread-a", ["one", "one", "two"]);
    expect(selected).toEqual({ "thread-a": ["one", "two"] });
    expect(setEnabledSkillsForThread(selected, "thread-a", [])).toEqual({});

    const full = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`thread-${index}`, [`skill-${index}`]]),
    );
    const bounded = setEnabledSkillsForThread(full, "thread-new", ["new"]);
    expect(Object.keys(bounded)).toHaveLength(256);
    expect(bounded["thread-0"]).toBeUndefined();
    expect(bounded["thread-new"]).toEqual(["new"]);
  });
});
