import { describe, expect, it } from "vite-plus/test";

import { ThreadId, type ServerProvider } from "@d4research/contracts";
import {
  listMobileSessionSkillNames,
  mobileProviderSupportsDelegationPipelines,
  mobilePromptForDevPipeline,
  mobilePromptForInteractionMode,
  mobileSessionSkillSettingsPatch,
  projectSkillNamesFromInventory,
  toggleMobileSessionSkill,
} from "./mobileSessionSkills";

const skill = (name: string, enabled = true) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled,
});

describe("mobile session skills", () => {
  it("keeps native Plan and dev pipelines mutually exclusive in both directions", () => {
    expect(mobilePromptForInteractionMode("!dev:review fix the race", "plan")).toBe("fix the race");
    expect(mobilePromptForDevPipeline("!research:default inspect the race", "review")).toBe(
      "!dev:review inspect the race",
    );
    expect(mobilePromptForDevPipeline("!dev:review fix the race", null)).toBe("fix the race");
  });

  it("rejects pipeline orchestration on providers without an MCP session", () => {
    expect(mobileProviderSupportsDelegationPipelines("agy")).toBe(false);
    expect(mobileProviderSupportsDelegationPipelines("junie")).toBe(false);
    expect(mobileProviderSupportsDelegationPipelines(undefined)).toBe(false);
    expect(mobileProviderSupportsDelegationPipelines("future-provider")).toBe(false);
    expect(mobileProviderSupportsDelegationPipelines("codex")).toBe(true);
    expect(mobileProviderSupportsDelegationPipelines("claudeAgent")).toBe(true);
  });

  it("keeps project skills while excluding user skills and commands", () => {
    expect(
      projectSkillNamesFromInventory([
        {
          name: "project-review",
          path: "/workspace/.agents/skills/project-review/SKILL.md",
          root: "project",
          kind: "skill",
          scope: "project",
          agents: ["all"],
          isSymlinked: false,
        },
        {
          name: "user-review",
          path: "/home/user/.agents/skills/user-review/SKILL.md",
          root: "codex-user",
          kind: "skill",
          scope: "user",
          agents: ["codex"],
          isSymlinked: false,
        },
        {
          name: "project-command",
          path: "/workspace/.agents/skills/project-command.md",
          root: "project",
          kind: "command",
          scope: "project",
          agents: ["junie"],
          isSymlinked: false,
        },
      ]),
    ).toEqual(["project-review"]);
  });

  it("lists path-backed skills across providers and preserves configured missing names", () => {
    const providers = [
      { skills: [skill("codex"), skill("disabled", false)] },
      { skills: [skill("claude"), skill("codex")] },
    ] as ReadonlyArray<Pick<ServerProvider, "skills">>;
    expect(
      listMobileSessionSkillNames({
        providers,
        globalNames: ["global-missing"],
        sessionNames: ["session-missing"],
        projectNames: ["project-only"],
      }),
    ).toEqual(["claude", "codex", "global-missing", "project-only", "session-missing"]);
  });

  it("locks global names, toggles chat names, and honors the shared context ceiling", () => {
    expect(
      toggleMobileSessionSkill({ globalNames: ["global"], sessionNames: [], name: "global" }),
    ).toBeNull();
    expect(
      toggleMobileSessionSkill({ globalNames: [], sessionNames: ["chat"], name: "chat" }),
    ).toEqual([]);
    expect(
      toggleMobileSessionSkill({
        globalNames: Array.from({ length: 11 }, (_, index) => `global-${index}`),
        sessionNames: ["first"],
        name: "second",
      }),
    ).toEqual(["first"]);
    expect(
      toggleMobileSessionSkill({
        globalNames: ["shared"],
        sessionNames: ["shared", "chat"],
        name: "second",
      }),
    ).toEqual(["chat", "second"]);
  });

  it("persists a chat-scoped selection against the durable thread id", () => {
    expect(mobileSessionSkillSettingsPatch(ThreadId.make("thread-mobile"), "review", true)).toEqual(
      {
        skills: {
          setEnabledForThreadSkill: {
            threadId: ThreadId.make("thread-mobile"),
            name: "review",
            enabled: true,
          },
        },
      },
    );
  });
});
