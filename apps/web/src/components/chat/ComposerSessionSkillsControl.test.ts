import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import type { SkillsInventoryEntry } from "../../hooks/useSkillsInventory";
import {
  buildSessionSkillOptions,
  ComposerSessionSkillsTriggerButton,
} from "./ComposerSessionSkillsControl";

const entry = (
  name: string,
  root: SkillsInventoryEntry["root"],
  description: string,
): SkillsInventoryEntry => ({
  name,
  root,
  description,
  path: `/skills/${root}/${name}/SKILL.md`,
  kind: "skill",
  scope: root === "project" ? "project" : "user",
  agents: ["all"],
  isSymlinked: false,
});

describe("buildSessionSkillOptions", () => {
  it("uses the project definition when names collide and excludes commands", () => {
    expect(
      buildSessionSkillOptions(
        [
          entry("review", "claude-user", "global description"),
          entry("review", "project", "project description"),
          { ...entry("command", "project", "not a skill"), kind: "command" },
        ],
        [],
      ),
    ).toEqual([{ name: "review", description: "project description", missing: false }]);
  });

  it("keeps missing configured names visible so the user can remove them", () => {
    expect(buildSessionSkillOptions([], ["missing"])).toEqual([
      { name: "missing", description: null, missing: true },
    ]);
  });
});

describe("ComposerSessionSkillsTriggerButton", () => {
  it("renders only the icon while keeping an accessible count", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerSessionSkillsTriggerButton, {
        effectiveCount: 2,
        hasSessionSkills: true,
      }),
    );
    expect(markup).toContain('aria-label="2 skills configured for this chat"');
    expect(markup).toContain('title="Skills for this chat"');
    expect(markup).not.toMatch(/>\s*Skills\s*</);
    expect(markup).not.toMatch(/>\s*2\s*</);
  });
});
