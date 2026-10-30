import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@d4research/client-runtime/environment";
import { presentPendingBackgroundWork } from "@d4research/client-runtime/state/thread-execution";
import { resolveSidebarThreadStatus, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export type DashboardStatus = "working" | "monitoring" | "ready" | "reviewed";
export interface DashboardItem {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly project: SidebarProjectSnapshot;
  readonly status: DashboardStatus;
  readonly attention: string | null;
  readonly description: string;
  readonly timestamp: string;
}
export interface DashboardFilters {
  readonly environment: string;
  readonly project: string;
  readonly query: string;
}

const RECENT_COMPLETION_MS = 24 * 60 * 60 * 1000;

export function collectDashboardItems(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly localVisits: Readonly<Record<string, string>>;
  readonly now: number;
}): DashboardItem[] {
  const projects = new Map(
    input.projects.flatMap((project) =>
      project.memberProjects.map(
        (member) => [`${member.environmentId}:${member.id}`, project] as const,
      ),
    ),
  );
  const items: DashboardItem[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt || thread.deletedAt || thread.lineage.relationshipToParent === "subagent")
      continue;
    const project = projects.get(`${thread.environmentId}:${thread.projectId}`);
    if (!project) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const phase = resolveSidebarThreadStatus(thread);
    const attention =
      phase === "request"
        ? "Guest message waiting"
        : phase === "approval"
          ? "Approval needed"
          : phase === "input"
            ? "Input needed"
            : phase === "limited"
              ? "Usage limit reached"
              : phase === "failed"
                ? "Turn failed"
                : null;
    let status: DashboardStatus;
    let timestamp =
      thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? thread.updatedAt;
    if (phase === "working" || phase === "approval" || phase === "input" || phase === "request")
      status = "working";
    else if (phase === "waiting") status = "monitoring";
    else {
      const completed = thread.latestRun?.completedAt;
      if (!completed) continue;
      const completedAt = Date.parse(completed);
      if (!Number.isFinite(completedAt)) continue;
      const visit = resolveThreadLastVisitedAt(thread.lastVisitedAt, input.localVisits[key]);
      const unread =
        !visit || !Number.isFinite(Date.parse(visit)) || completedAt > Date.parse(visit);
      if (!unread && completedAt < input.now - RECENT_COMPLETION_MS) continue;
      status = unread ? "ready" : "reviewed";
      timestamp = completed;
    }
    const preview = thread.source.latestVisibleMessage;
    const description =
      attention !== null
        ? thread.runtime?.lastError || attention
        : status === "monitoring"
          ? (presentPendingBackgroundWork(thread.pendingBackgroundTasks)?.title ??
            "Waiting for connected work to finish.")
          : preview?.role === "assistant" && preview.text.trim()
            ? preview.text.trim().replace(/\s+/gu, " ").slice(0, 220)
            : status === "working"
              ? "Agent is working on the current turn."
              : status === "ready"
                ? "The turn has finished. Open the thread to review its result."
                : "Completed result you have already opened.";
    items.push({ key, thread, project, status, attention, description, timestamp });
  }
  return items.sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.key.localeCompare(b.key),
  );
}

export function filterDashboardItems(
  items: ReadonlyArray<DashboardItem>,
  filters: DashboardFilters,
  environmentLabels: ReadonlyMap<string, string>,
): DashboardItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (filters.environment === "all" || item.thread.environmentId === filters.environment) &&
      (filters.project === "all" || item.project.projectKey === filters.project) &&
      (!query ||
        [
          item.thread.title,
          item.thread.branch,
          item.project.displayName,
          item.description,
          item.thread.modelSelection.model,
          environmentLabels.get(item.thread.environmentId),
        ].some((value) => value?.toLocaleLowerCase().includes(query))),
  );
}
