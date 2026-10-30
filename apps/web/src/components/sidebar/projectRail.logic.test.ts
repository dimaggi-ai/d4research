import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@d4research/contracts";
import { scopeThreadRef, scopedThreadKey } from "@d4research/client-runtime/environment";
import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";

import { projectRailStatuses } from "./projectRail.logic";

function thread(input: {
  id: string;
  projectId: string;
  archivedAt?: string;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  sessionStatus?: string;
}): EnvironmentThreadShell {
  return {
    environmentId: "local",
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId),
    title: input.id,
    archivedAt: input.archivedAt ?? null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    runtime: input.sessionStatus ? { status: input.sessionStatus } : null,
    latestRun: null,
    pendingBackgroundTasks: [],
  } as unknown as EnvironmentThreadShell;
}

describe("projectRailStatuses", () => {
  it("marks projects with a running session, a pending approval, or a question", () => {
    const keys = projectRailStatuses(
      [
        thread({ id: "a", projectId: "running", sessionStatus: "running" }),
        thread({ id: "b", projectId: "approval", hasPendingApprovals: true }),
        thread({ id: "c", projectId: "question", hasPendingUserInput: true }),
        thread({ id: "d", projectId: "quiet" }),
      ],
      {},
    );
    expect(keys.get("local:running")).toEqual({
      running: true,
      monitoring: false,
      completed: false,
      input: false,
    });
    expect(keys.get("local:approval")?.input).toBe(true);
    expect(keys.get("local:question")?.input).toBe(true);
    expect(keys.get("local:quiet")).toEqual({
      running: false,
      monitoring: false,
      completed: false,
      input: false,
    });
  });

  it("ignores archived threads, which the sidebar hides until asked", () => {
    const keys = projectRailStatuses(
      [
        thread({
          id: "e",
          projectId: "archived",
          hasPendingApprovals: true,
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      {},
    );
    expect(keys.size).toBe(0);
  });
});

it("keeps all three project signals and clears only completions that were read", () => {
  const completed = {
    ...thread({ id: "completed", projectId: "mixed" }),
    latestRun: { completedAt: "2026-09-27T12:00:00.000Z" },
  } as EnvironmentThreadShell;
  const threads = [
    completed,
    thread({ id: "running", projectId: "mixed", sessionStatus: "running" }),
    thread({ id: "question", projectId: "mixed", hasPendingUserInput: true }),
    { ...completed, environmentId: EnvironmentId.make("remote") },
  ];
  const key = scopedThreadKey(scopeThreadRef(completed.environmentId, completed.id));
  expect(
    projectRailStatuses(threads, { [key]: "2026-09-27T11:00:00.000Z" }).get("local:mixed"),
  ).toEqual({ running: true, monitoring: false, completed: true, input: true });
  expect(
    projectRailStatuses(threads, { [key]: "2026-09-27T13:00:00.000Z" }).get("local:mixed"),
  ).toEqual({ running: true, monitoring: false, completed: false, input: true });
  expect(
    projectRailStatuses(threads, { [key]: "2026-09-27T11:00:00.000Z" }).get("remote:mixed")
      ?.completed,
  ).toBe(false);
});

it("keeps a background command visible until its roster clears, alongside pending input", () => {
  const base = thread({ id: "background", projectId: "background", hasPendingUserInput: true });
  const running = {
    ...base,
    pendingBackgroundTasks: [{ taskId: "command", kind: "command" as const }],
  };
  expect(projectRailStatuses([running], {}).get("local:background")).toEqual({
    running: false,
    monitoring: true,
    completed: false,
    input: true,
  });
  expect(
    projectRailStatuses([{ ...running, pendingBackgroundTasks: [] }], {}).get("local:background"),
  ).toEqual({ running: false, monitoring: false, completed: false, input: true });
});

it("distinguishes foreground activity from background monitoring while retaining project presence", () => {
  const idle = {
    ...thread({ id: "monitoring", projectId: "watch", sessionStatus: "completed" }),
    pendingBackgroundTasks: [{ taskId: "verification", kind: "command" as const }],
  };
  expect(projectRailStatuses([idle], {}).get("local:watch")).toMatchObject({
    running: false,
    monitoring: true,
  });
  expect(
    projectRailStatuses(
      [idle, thread({ id: "agent", projectId: "watch", sessionStatus: "running" })],
      {},
    ).get("local:watch"),
  ).toMatchObject({ running: true, monitoring: true });
  expect(
    projectRailStatuses([{ ...idle, pendingBackgroundTasks: [] }], {}).get("local:watch"),
  ).toMatchObject({ running: false, monitoring: false });
});
