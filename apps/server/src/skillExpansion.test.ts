import { describe, expect, it } from "vite-plus/test";

import { buildSkillReferenceBlock, expandSkillTokens, findSkillTokens } from "./skillExpansion.ts";

const reviewSkill = {
  name: "security-review",
  description: "Review code for vulnerabilities.",
  path: "/home/dev/.claude/skills/security-review/SKILL.md",
};
const storyboardSkill = {
  name: "storyboard",
  path: "/home/dev/.codex/skills/storyboard/SKILL.md",
};

describe("findSkillTokens", () => {
  it("finds tokens at a word boundary and records their offsets", () => {
    const text = "run $security-review then $storyboard";
    expect(findSkillTokens(text)).toEqual([
      { name: "security-review", index: 4 },
      { name: "storyboard", index: 26 },
    ]);
  });

  it("returns nothing when the text has no dollar sign", () => {
    expect(findSkillTokens("no attachments here")).toEqual([]);
  });

  it("ignores dollars inside inline code spans and fenced blocks", () => {
    const text = ["use `$security-review` literally", "```sh", "echo $storyboard", "```"].join(
      "\n",
    );
    expect(findSkillTokens(text)).toEqual([]);
  });

  it("ignores $$ and mid-word dollars", () => {
    expect(findSkillTokens("cost is $$storyboard and a$storyboard")).toEqual([]);
  });

  it("drops trailing sentence punctuation from the name", () => {
    expect(findSkillTokens("apply $storyboard.")).toEqual([{ name: "storyboard", index: 6 }]);
  });
});

describe("buildSkillReferenceBlock", () => {
  it("emits a compact reference, not the skill body, and never claims a run", () => {
    const block = buildSkillReferenceBlock([reviewSkill]);
    expect(block).toContain("attaching a skill does not run it");
    expect(block).toContain("- $security-review — Review code for vulnerabilities.");
    expect(block).toContain(`Instructions: ${reviewSkill.path}`);
    expect(block).toContain("Read that file before applying this skill.");
  });

  it("is empty with no skills", () => {
    expect(buildSkillReferenceBlock([])).toBe("");
  });
});

describe("expandSkillTokens", () => {
  it("appends the reference block and keeps the original token", () => {
    const result = expandSkillTokens({
      text: "please run $security-review on this diff",
      workspaceSkills: [reviewSkill, storyboardSkill],
    });
    expect(result.expanded).toEqual(["security-review"]);
    expect(result.missing).toEqual([]);
    expect(result.text.startsWith("please run $security-review on this diff")).toBe(true);
    expect(result.text).toContain(reviewSkill.path);
  });

  it("does not expand a skill the provider resolves natively", () => {
    const result = expandSkillTokens({
      text: "run $security-review",
      workspaceSkills: [reviewSkill],
      nativeSkillNames: ["security-review"],
    });
    expect(result).toEqual({ text: "run $security-review", expanded: [], missing: [] });
  });

  it("leaves an unknown token untouched", () => {
    const result = expandSkillTokens({
      text: "run $not-a-skill",
      workspaceSkills: [reviewSkill],
    });
    expect(result).toEqual({ text: "run $not-a-skill", expanded: [], missing: [] });
  });

  it("notes a skill whose file went missing instead of dropping it silently", () => {
    const result = expandSkillTokens({
      text: "run $security-review",
      workspaceSkills: [{ ...reviewSkill, available: false }],
    });
    expect(result.expanded).toEqual([]);
    expect(result.missing).toEqual(["security-review"]);
    expect(result.text).toContain("skill file missing");
  });

  it("expands multiple tokens once each", () => {
    const result = expandSkillTokens({
      text: "$security-review and $storyboard and $security-review again",
      workspaceSkills: [reviewSkill, storyboardSkill],
    });
    expect(result.expanded).toEqual(["security-review", "storyboard"]);
    expect(result.text.match(/Instructions:/g)).toHaveLength(2);
  });

  it("returns the text unchanged on the no-token fast path", () => {
    const result = expandSkillTokens({
      text: "plain message",
      workspaceSkills: [reviewSkill],
    });
    expect(result.text).toBe("plain message");
  });
});
