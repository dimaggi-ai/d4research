import { describe, expect, it } from "vite-plus/test";

import {
  describeComposerFallbackSkill,
  providerSkillsToInventoryEntries,
  toComposerFallbackSkills,
} from "./composerSkillFallback";
import type { SkillsInventoryEntry } from "./hooks/useSkillsInventory";

const entry = (overrides: Partial<SkillsInventoryEntry>): SkillsInventoryEntry => ({
  name: "security-review",
  path: "/home/dev/.claude/skills/security-review/SKILL.md",
  root: "claude-user",
  kind: "skill",
  scope: "user",
  agents: ["claude"],
  isSymlinked: false,
  ...overrides,
});

describe("toComposerFallbackSkills", () => {
  it("offers skills from every root the server can expand", () => {
    const skills = toComposerFallbackSkills([
      entry({ description: "Review code." }),
      entry({ name: "storyboard", root: "codex-user" }),
      entry({ name: "update-docs", root: "project", scope: "project" }),
    ]);
    expect(skills.map((skill) => skill.name)).toEqual([
      "security-review",
      "storyboard",
      "update-docs",
    ]);
    expect(skills[0]?.description).toBe("Review code.");
  });

  it("keeps one entry per name when roots alias each other", () => {
    const skills = toComposerFallbackSkills([entry({}), entry({ root: "codex-user" })]);
    expect(skills).toHaveLength(1);
  });

  it("keeps project skills visible when an Agy snapshot already reports user skills", () => {
    const providerEntries = providerSkillsToInventoryEntries([
      {
        skills: [
          {
            name: "review",
            path: "/remote/home/.agents/skills/review/SKILL.md",
            enabled: true,
            scope: "user",
          },
        ],
      },
    ]);
    const skills = toComposerFallbackSkills([
      ...providerEntries,
      entry({
        name: "review",
        path: "/remote/project/.agents/skills/review/SKILL.md",
        root: "project",
        scope: "project",
        agents: ["all"],
      }),
      entry({
        name: "project-only",
        path: "/remote/project/.agents/skills/project-only/SKILL.md",
        root: "project",
        scope: "project",
        agents: ["all"],
      }),
    ]);
    expect(skills).toEqual([
      expect.objectContaining({
        name: "review",
        scope: "project",
        path: "/remote/project/.agents/skills/review/SKILL.md",
      }),
      expect.objectContaining({ name: "project-only", scope: "project" }),
    ]);
  });
});

describe("describeComposerFallbackSkill", () => {
  it("says the skill is attached, never that it runs", () => {
    expect(
      describeComposerFallbackSkill({
        name: "security-review",
        path: "/x/SKILL.md",
        enabled: true,
        description: "Review code.",
      }),
    ).toBe("Attach as instructions — Review code.");
    expect(
      describeComposerFallbackSkill({ name: "bare", path: "/x/SKILL.md", enabled: true }),
    ).toBe("Attach as instructions");
  });
});

describe("providerSkillsToInventoryEntries", () => {
  it("uses the selected environment snapshots and keeps project shadowing metadata", () => {
    expect(
      providerSkillsToInventoryEntries([
        {
          skills: [
            {
              name: "review",
              path: "/remote/project/.agents/skills/review/SKILL.md",
              enabled: true,
              scope: "project",
              description: "Remote project copy.",
            },
            { name: "disabled", path: "/remote/disabled/SKILL.md", enabled: false },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        name: "review",
        root: "project",
        scope: "project",
        path: "/remote/project/.agents/skills/review/SKILL.md",
      }),
    ]);
  });
});
