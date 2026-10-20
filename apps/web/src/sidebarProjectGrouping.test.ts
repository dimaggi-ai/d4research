import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@d4research/contracts";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
} from "./sidebarProjectGrouping";
import { derivePhysicalProjectKey, type ProjectGroupingSettings } from "./logicalProject";
import type { Project } from "./types";

const project: Project = {
  environmentId: EnvironmentId.make("local"),
  id: ProjectId.make("notes"),
  title: "Notes",
  workspaceRoot: "/work/notes",
  repositoryIdentity: {
    canonicalKey: "target",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://example.test/notes.git",
    },
    provider: "github",
    owner: "example",
    name: "notes",
    displayName: "Notes",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};
const settings: ProjectGroupingSettings = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
};
const groups = buildSidebarProjectSnapshots({
  projects: [project],
  settings,
  primaryEnvironmentId: project.environmentId,
  resolveEnvironmentLabel: () => "Local",
});
describe("resolveSidebarProjectScopeKey", () => {
  it.each([derivePhysicalProjectKey(project), "local:notes", "target"])(
    "resolves saved key %s through the current logical group",
    (key) => {
      expect(
        resolveSidebarProjectScopeKey({ groups, key, settings, canClearMissingScope: true }),
      ).toBe("target");
    },
  );
  it("ignores removed slots while preserving temporarily disconnected scopes", () => {
    expect(
      resolveSidebarProjectScopeKey({
        groups,
        key: "removed",
        settings,
        canClearMissingScope: true,
      }),
    ).toBeNull();
    expect(resolveSidebarProjectScopeKey({ groups, key: "removed", settings })).toBe("removed");
  });
});
