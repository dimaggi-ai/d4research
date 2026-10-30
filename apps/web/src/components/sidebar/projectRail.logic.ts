import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";

import { scopeThreadRef, scopedThreadKey } from "@d4research/client-runtime/environment";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

export interface ProjectRailStatus {
  running: boolean;
  monitoring: boolean;
  completed: boolean;
  input: boolean;
}

export function projectRailStatuses(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  lastVisitedByThread: Readonly<Record<string, string>>,
): ReadonlyMap<string, ProjectRailStatus> {
  const projects = new Map<string, ProjectRailStatus>();
  for (const thread of threads) {
    if (thread.archivedAt != null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const status = projects.get(key) ?? {
      running: false,
      monitoring: false,
      completed: false,
      input: false,
    };
    const threadStatus = resolveSidebarThreadStatus(thread);
    status.running ||= threadStatus === "working";
    status.monitoring ||=
      threadStatus !== "working" && (thread.pendingBackgroundTasks?.length ?? 0) > 0;
    status.input ||=
      threadStatus === "approval" || threadStatus === "input" || threadStatus === "request";
    status.completed ||= hasUnseenCompletion({
      ...thread,
      lastVisitedAt:
        lastVisitedByThread[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    });
    projects.set(key, status);
  }
  return projects;
}

export const EMPTY_PROJECT_RAIL_STATUS: ProjectRailStatus = {
  running: false,
  monitoring: false,
  completed: false,
  input: false,
};

export function combineProjectRailStatuses(
  statuses: Iterable<ProjectRailStatus | undefined>,
): ProjectRailStatus {
  const combined = { ...EMPTY_PROJECT_RAIL_STATUS };
  for (const status of statuses) {
    if (!status) continue;
    combined.running ||= status.running;
    combined.monitoring ||= status.monitoring;
    combined.completed ||= status.completed;
    combined.input ||= status.input;
  }
  return combined;
}

export function projectRailStatusLabel(status: ProjectRailStatus): string {
  return [
    status.running && "Agent working",
    status.monitoring && "Monitoring background work",
    status.completed && "Unread completion",
    status.input && "Input or approval needed",
  ]
    .filter(Boolean)
    .join(", ");
}

export function railGroupStatusSummary(statuses: ReadonlyArray<ProjectRailStatus>): string {
  const working = statuses.filter((status) => status.running).length;
  const input = statuses.filter((status) => status.input).length;
  const unread = statuses.filter((status) => status.completed).length;
  const parts = [`${statuses.length} ${statuses.length === 1 ? "project" : "projects"}`];
  if (working > 0) parts.push(`${working} working`);
  if (input > 0) parts.push(`${input} ${input === 1 ? "needs" : "need"} input`);
  if (unread > 0) parts.push(`${unread} unread`);
  return parts.join(" · ");
}
