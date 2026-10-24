import {
  OrchestrationV2ThreadShell,
  AgentMonitorReport,
  RepositoryIdentity,
  ThreadPullRequestLink,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type AgentMonitorUpdate,
  type ThreadId,
} from "@d4research/contracts";
import * as Schema from "effect/Schema";

const sameThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);
const sameMonitorReport = Schema.toEquivalence(Schema.NullOr(AgentMonitorReport));
const sameLinks = Schema.toEquivalence(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink)));
const sameRepositoryIdentity = Schema.toEquivalence(
  Schema.UndefinedOr(Schema.NullOr(RepositoryIdentity)),
);

export function sameThreadPullRequests(
  left: OrchestrationV2ThreadShell["pullRequests"],
  right: OrchestrationV2ThreadShell["pullRequests"],
): boolean {
  return left === right || sameLinks(left, right);
}

/**
 * Links are compared apart from the rest of the row because a deferred snapshot arrives without
 * them; such a row keeps its links until they fill in.
 */
export function reuseUnchangedThreadShells(
  previous: OrchestrationV2ShellSnapshot | null,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous.threads.length === 0) return next;
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread] as const));
  let reused = 0;
  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);
    if (prior === undefined) return thread;
    const candidate =
      thread.pullRequests === undefined && prior.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    if (!sameThreadShell(prior, candidate)) return thread;
    reused += 1;
    return prior;
  });
  return reused === 0 ? next : { ...next, threads };
}

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

function retainRepositoryIdentity(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    return { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  return next;
}

export interface MergeShellSnapshotOptions {
  /**
   * Metadata-only enrichment refresh: structure and sequence never change;
   * listed roots accept identity exactly (including null).
   * Omit this options object for authoritative HTTP/initial WebSocket snapshots.
   */
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}

export function mergeShellSnapshotProjects(
  previous: OrchestrationV2ShellSnapshot | null | undefined,
  next: OrchestrationV2ShellSnapshot,
  options?: MergeShellSnapshotOptions,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous === undefined) {
    return next;
  }

  const isEnrichment = options !== undefined;
  const resolvedRootSet = isEnrichment ? new Set(options.resolvedRepositoryIdentityRoots) : null;

  if (isEnrichment) {
    const nextById = new Map(next.projects.map((project) => [project.id, project] as const));
    return {
      ...previous,
      projects: previous.projects.map((project) => {
        const candidate = nextById.get(project.id);
        if (candidate === undefined || candidate.workspaceRoot !== project.workspaceRoot) {
          return project;
        }
        if (resolvedRootSet?.has(project.workspaceRoot) === true) {
          // Refreshes re-resolve every root; an unchanged identity keeps the project's identity
          // so every subscriber (each pull request row, the sidebar) skips re-rendering.
          if (sameRepositoryIdentity(project.repositoryIdentity, candidate.repositoryIdentity)) {
            return project;
          }
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        if (project.repositoryIdentity == null && candidate.repositoryIdentity != null) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        return project;
      }),
    };
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  return {
    ...next,
    projects: next.projects.map((project) => {
      const prior = previousById.get(project.id);
      if (resolvedRootSet?.has(project.workspaceRoot) === true) {
        return project;
      }
      return retainRepositoryIdentity(prior, project);
    }),
  };
}

export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Exclude<
    OrchestrationV2ShellStreamItem,
    { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
  >,
  pendingMonitorUpdates?: Map<ThreadId, AgentMonitorUpdate>,
): OrchestrationV2ShellSnapshot {
  if (event.kind === "monitor.snapshot" || event.kind === "monitor.updated") {
    const authoritative = event.kind === "monitor.snapshot";
    const reports = authoritative ? event.reports : [event];
    if (authoritative) pendingMonitorUpdates?.clear();
    const byThread = new Map(reports.map((report) => [report.threadId, report]));
    let changed = false;
    const threads = snapshot.threads.map((thread) => {
      const update = byThread.get(thread.id);
      byThread.delete(thread.id);
      if (update === undefined) {
        if (
          !authoritative ||
          (thread.agentMonitor == null && (thread.agentMonitorRevision ?? 0) === 0)
        )
          return thread;
        changed = true;
        return { ...thread, agentMonitor: null, agentMonitorRevision: 0 };
      }
      const revision = thread.agentMonitorRevision ?? 0;
      if (!authoritative && update.revision <= revision) {
        return thread;
      }
      if (
        thread.agentMonitorRevision === update.revision &&
        sameMonitorReport(thread.agentMonitor ?? null, update.report)
      )
        return thread;
      changed = true;
      return { ...thread, agentMonitor: update.report, agentMonitorRevision: update.revision };
    });
    for (const update of byThread.values()) {
      const previous = pendingMonitorUpdates?.get(update.threadId);
      if (previous === undefined || previous.revision < update.revision) {
        pendingMonitorUpdates?.set(update.threadId, update);
      }
    }
    return changed ? { ...snapshot, threads } : snapshot;
  }
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated": {
      // Enrichment is async. A project mutation can land with null
      // repositoryIdentity while an earlier snapshot already resolved it.
      // Keep the prior identity for the same workspace root so multi-env
      // grouping does not split until a full snapshot refresh arrives.
      const previous = snapshot.projects.find((project) => project.id === event.project.id);
      const project = retainRepositoryIdentity(previous, event.project);
      return {
        ...snapshot,
        projects: upsertById(snapshot.projects, project),
        snapshotSequence: event.sequence,
      };
    }
    case "project.removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread.updated": {
      const existing =
        event.location === "active"
          ? snapshot.threads.find((thread) => thread.id === event.thread.id)
          : undefined;
      let thread = event.thread;
      if ((existing?.agentMonitorRevision ?? 0) > (thread.agentMonitorRevision ?? 0)) {
        thread = {
          ...thread,
          agentMonitor: existing?.agentMonitor ?? null,
          agentMonitorRevision: existing!.agentMonitorRevision,
        };
      }
      const pending = pendingMonitorUpdates?.get(thread.id);
      pendingMonitorUpdates?.delete(thread.id);
      if (pending !== undefined && pending.revision >= (thread.agentMonitorRevision ?? 0)) {
        thread = {
          ...thread,
          agentMonitor: pending.report,
          agentMonitorRevision: pending.revision,
        };
      }
      if (existing !== undefined && sameThreadShell(existing, thread)) {
        return { ...snapshot, snapshotSequence: event.sequence };
      }
      const withoutThread = (threads: OrchestrationV2ShellSnapshot["threads"]) =>
        threads.filter((thread) => thread.id !== event.thread.id);
      return {
        ...snapshot,
        threads:
          event.location === "active"
            ? upsertById(snapshot.threads, thread)
            : withoutThread(snapshot.threads),
        // The archive has its own bounded query/subscription. Older servers may
        // still send archive-located deltas here; remove them from the normal
        // shell instead of growing its persisted cache again.
        archivedThreads: withoutThread(snapshot.archivedThreads),
        snapshotSequence: event.sequence,
      };
    }
    case "thread.removed":
      pendingMonitorUpdates?.delete(event.threadId);
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        archivedThreads: snapshot.archivedThreads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}

export function createShellStreamEventReducer(maxPendingMonitorUpdates = 1_000) {
  const pending = new Map<ThreadId, AgentMonitorUpdate>();
  return {
    reset: () => pending.clear(),
    apply: (
      snapshot: OrchestrationV2ShellSnapshot,
      event: Exclude<
        OrchestrationV2ShellStreamItem,
        { readonly kind: "snapshot" | "synchronized" }
      >,
    ) => {
      const next = applyShellStreamEvent(snapshot, event, pending);
      // A slow structural stream must resynchronize instead of retaining missing threads forever.
      const resyncRequired = pending.size > maxPendingMonitorUpdates;
      if (resyncRequired) pending.clear();
      return { snapshot: next, resyncRequired };
    },
  };
}
