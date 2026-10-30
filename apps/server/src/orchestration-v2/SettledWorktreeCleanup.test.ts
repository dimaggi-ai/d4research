import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { isSettledWorktreeExpired } from "./SettledWorktreeCleanup.ts";
const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 settled worktree retention", () => {
  const candidate = () =>
    shell({ branch: "feature", worktreePath: "/worktrees/feature", settledAt: at(-10 * DAY_MS) });
  it("retains seven days from settlement and all newer activity", () => {
    expect(isSettledWorktreeExpired(candidate(), NOW_MS)).toBe(true);
    for (const overrides of [
      { settledAt: at(-6 * DAY_MS) },
      { updatedAt: at(-6 * DAY_MS) },
      { latestUserMessageAt: at(-6 * DAY_MS) },
      { latestRunCompletedAt: at(-6 * DAY_MS) },
    ])
      expect(isSettledWorktreeExpired({ ...candidate(), ...overrides }, NOW_MS)).toBe(false);
  });
  it("protects active and explicitly kept-active work", () => {
    expect(
      isSettledWorktreeExpired({ ...candidate(), activeRunId: RunId.make("running") }, NOW_MS),
    ).toBe(false);
    expect(isSettledWorktreeExpired({ ...candidate(), settledOverride: "active" }, NOW_MS)).toBe(
      false,
    );
    expect(isSettledWorktreeExpired({ ...candidate(), status: "waiting" }, NOW_MS)).toBe(false);
    expect(isSettledWorktreeExpired(shell(), NOW_MS)).toBe(false);
  });
});
