import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@d4research/contracts";
import type {
  EnvironmentThreadShell,
  EnvironmentProject,
} from "@d4research/client-runtime/state/shell";
import { makeThreadFixture } from "../../test-fixtures";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { DEFAULT_CLIENT_SETTINGS } from "@d4research/contracts/settings";
import { selectProjectGroupingSettings } from "../../logicalProject";

export const DASHBOARD_NOW = "2026-10-24T21:00:00.000Z";
export const LOCAL = EnvironmentId.make("local");
export const REMOTE = EnvironmentId.make("remote");
export function dashboardThread(
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: LOCAL,
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Fix the worktree viewer",
    updatedAt: "2026-10-24T20:30:00.000Z",
    lastVisitedAt: null,
    latestRun: {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: "2026-10-24T20:00:00.000Z",
      startedAt: "2026-10-24T20:00:00.000Z",
      completedAt: "2026-10-24T20:30:00.000Z",
      assistantMessageId: null,
    },
    ...overrides,
  });
}
export function dashboardProjects() {
  const projects: EnvironmentProject[] = [LOCAL, REMOTE].map((environmentId) => ({
    environmentId,
    id: ProjectId.make("project-1"),
    title: "T3 Code",
    workspaceRoot: `/work/${environmentId}/t3code`,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: DASHBOARD_NOW,
    updatedAt: DASHBOARD_NOW,
    scripts: [],
    projectIcon: { kind: "emoji", emoji: "🚀" },
  }));
  return buildSidebarProjectSnapshots({
    projects,
    settings: selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
    primaryEnvironmentId: LOCAL,
    resolveEnvironmentLabel: (id) => (id === LOCAL ? "Local Mac" : "Mac mini"),
  });
}
