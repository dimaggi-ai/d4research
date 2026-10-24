import { ProjectId, ThreadId, type ThreadPullRequestLink } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  applyShellStreamEvent,
  createShellStreamEventReducer,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
} from "./shellReducer.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/example/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/repo.git",
  },
};

const otherIdentity = {
  canonicalKey: "github.com/example/other",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/other.git",
  },
};

describe("monitor shell updates", () => {
  const report = {
    schemaVersion: 1 as const,
    classification: "needs_user" as const,
    reason: "pending_request" as const,
    attentionRequired: true,
    notificationEligible: true,
    reportKey: "request-1",
    observedAt: "2026-10-24T00:00:00.000Z",
    runId: null,
    attemptId: null,
    runStatus: null,
    pendingRequestId: null,
  };
  const snapshot = {
    ...v2ShellSnapshot,
    snapshotSequence: 42,
    threads: [{ ...v2ThreadShell, agentMonitor: report, agentMonitorRevision: 1 }],
  };

  it("clears reports on resume without advancing the application cursor or activity", () => {
    const next = applyShellStreamEvent(snapshot, {
      kind: "monitor.snapshot",
      reports: [{ threadId: v2ThreadShell.id, revision: 2, report: null }],
    });
    expect(next.threads[0]?.agentMonitor).toBeNull();
    expect(next.threads[0]?.agentMonitorRevision).toBe(2);
    expect(next.threads[0]?.updatedAt).toBe(snapshot.threads[0]?.updatedAt);
    expect(next.snapshotSequence).toBe(42);
    expect(next.projects).toBe(snapshot.projects);
  });

  it("ignores buffered updates older than the resume snapshot, including a cleared report", () => {
    const cleared = applyShellStreamEvent(snapshot, {
      kind: "monitor.snapshot",
      reports: [{ threadId: v2ThreadShell.id, revision: 3, report: null }],
    });
    for (const revision of [1, 2, 3]) {
      expect(
        applyShellStreamEvent(cleared, {
          kind: "monitor.updated",
          threadId: v2ThreadShell.id,
          revision,
          report,
        }),
      ).toBe(cleared);
    }
    const next = applyShellStreamEvent(cleared, {
      kind: "monitor.updated",
      threadId: v2ThreadShell.id,
      revision: 4,
      report,
    });
    expect(next.threads[0]?.agentMonitor).toBe(report);
    expect(next.snapshotSequence).toBe(42);
  });

  it("retains a newer report when delayed whole-thread updates arrive", () => {
    const next = applyShellStreamEvent(snapshot, {
      kind: "thread.updated",
      sequence: 43,
      location: "active",
      thread: { ...v2ThreadShell, title: "Renamed", agentMonitor: null, agentMonitorRevision: 0 },
    });
    expect(next.threads[0]?.title).toBe("Renamed");
    expect(next.threads[0]?.agentMonitor).toBe(report);
    expect(next.threads[0]?.agentMonitorRevision).toBe(1);
    expect(next.snapshotSequence).toBe(43);
  });

  it("resets cached revisions when an authoritative snapshot comes from a restored database", () => {
    const cached = {
      ...snapshot,
      threads: [{ ...snapshot.threads[0]!, agentMonitorRevision: 100 }],
    };
    const restored = applyShellStreamEvent(cached, {
      kind: "monitor.snapshot",
      reports: [{ threadId: v2ThreadShell.id, revision: 1, report: null }],
    });
    expect(restored.threads[0]?.agentMonitorRevision).toBe(1);
    expect(restored.threads[0]?.agentMonitor).toBeNull();
    expect(
      applyShellStreamEvent(restored, {
        kind: "monitor.updated",
        threadId: v2ThreadShell.id,
        revision: 2,
        report,
      }).threads[0]?.agentMonitor,
    ).toBe(report);
    const absent = applyShellStreamEvent(cached, { kind: "monitor.snapshot", reports: [] });
    expect(absent.threads[0]?.agentMonitorRevision).toBe(0);
    expect(absent.threads[0]?.agentMonitor).toBeNull();
    expect(absent.snapshotSequence).toBe(cached.snapshotSequence);
  });

  it("keeps a new thread's latest report until its structural update arrives", () => {
    const reducer = createShellStreamEventReducer();
    const empty = { ...snapshot, threads: [] };
    for (const revision of [3, 2]) {
      expect(
        reducer.apply(empty, {
          kind: "monitor.updated",
          threadId: v2ThreadShell.id,
          revision,
          report,
        }).snapshot,
      ).toBe(empty);
    }
    const next = reducer.apply(empty, {
      kind: "thread.updated",
      sequence: 43,
      location: "active",
      thread: v2ThreadShell,
    });
    expect(next.snapshot.threads[0]?.agentMonitor).toBe(report);
    expect(next.snapshot.threads[0]?.agentMonitorRevision).toBe(3);
    expect(next.resyncRequired).toBe(false);
  });

  it("replaces pending updates on authoritative monitor snapshots and subscription resets", () => {
    const reducer = createShellStreamEventReducer();
    const empty = { ...snapshot, threads: [] };
    reducer.apply(empty, {
      kind: "monitor.updated",
      threadId: v2ThreadShell.id,
      revision: 3,
      report,
    });
    reducer.apply(empty, {
      kind: "monitor.snapshot",
      reports: [{ threadId: v2ThreadShell.id, revision: 4, report: null }],
    });
    const next = reducer.apply(empty, {
      kind: "thread.updated",
      sequence: 43,
      location: "active",
      thread: v2ThreadShell,
    });
    expect(next.snapshot.threads[0]?.agentMonitor).toBeNull();
    expect(next.snapshot.threads[0]?.agentMonitorRevision).toBe(4);
    reducer.apply(empty, {
      kind: "monitor.updated",
      threadId: v2ThreadShell.id,
      revision: 5,
      report,
    });
    reducer.reset();
    expect(
      reducer.apply(empty, {
        kind: "thread.updated",
        sequence: 43,
        location: "active",
        thread: v2ThreadShell,
      }).snapshot.threads[0],
    ).toBe(v2ThreadShell);
  });

  it("requests resynchronization when unmatched updates exceed the buffer limit", () => {
    const reducer = createShellStreamEventReducer(2);
    const empty = { ...snapshot, threads: [] };
    for (const [index, id] of ["a", "b", "c"].entries()) {
      expect(
        reducer.apply(empty, {
          kind: "monitor.updated",
          threadId: ThreadId.make(id),
          revision: index + 1,
          report,
        }).resyncRequired,
      ).toBe(index === 2);
    }
    expect(
      reducer.apply(empty, {
        kind: "thread.updated",
        sequence: 43,
        location: "active",
        thread: { ...v2ThreadShell, id: ThreadId.make("a") },
      }).snapshot.threads[0]?.agentMonitor,
    ).toBeUndefined();
  });
});

describe("applyShellStreamEvent", () => {
  it("updates a thread in place without moving its siblings", () => {
    const threads = ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) }));
    const updated = { ...threads[1]!, title: "Streaming" };
    const next = applyShellStreamEvent(
      { ...v2ShellSnapshot, threads },
      {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: updated,
      },
    );
    expect(next.threads.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
    expect(next.threads[0]).toBe(threads[0]);
    expect(next.threads[1]).toBe(updated);
    expect(next.threads[2]).toBe(threads[2]);
  });

  it("keeps the thread list and object when an update changes nothing", () => {
    const threads = ["a", "b"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) }));
    const next = applyShellStreamEvent(
      { ...v2ShellSnapshot, threads },
      {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: { ...threads[1]! },
      },
    );
    expect(next.threads).toBe(threads);
    expect(next.snapshotSequence).toBe(1);
  });

  it("ignores stale project updates without mutating the snapshot", () => {
    const snapshotWithProject = {
      ...v2ShellSnapshot,
      snapshotSequence: 4,
      projects: [v2Project],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project.updated",
        sequence,
        project: { ...v2Project, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe(v2Project.title);
    }
  });

  it("applies project updates and removals", () => {
    const updated = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, title: "Updated" },
    });
    expect(updated.projects[0]?.title).toBe("Updated");
    expect(updated.snapshotSequence).toBe(1);

    const removed = applyShellStreamEvent(updated, {
      kind: "project.removed",
      sequence: 2,
      projectId: ProjectId.make(v2Project.id),
    });
    expect(removed.projects).toEqual([]);
  });

  it("keeps prior repositoryIdentity when a delta arrives with null identity", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });
    expect(withIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);

    const withoutIdentity = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: { ...v2Project, title: "Still same root", repositoryIdentity: null },
    });
    expect(withoutIdentity.projects[0]?.title).toBe("Still same root");
    expect(withoutIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("does not keep prior repositoryIdentity after a workspace root move", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });

    const moved = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: {
        ...v2Project,
        workspaceRoot: "/tmp/other-root",
        repositoryIdentity: null,
      },
    });
    expect(moved.projects[0]?.workspaceRoot).toBe("/tmp/other-root");
    expect(moved.projects[0]?.repositoryIdentity).toBeNull();
  });

  it("merges full snapshot projects without dropping known repositoryIdentity", () => {
    const previous = {
      ...v2ShellSnapshot,
      projects: [{ ...v2Project, repositoryIdentity }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 2,
      projects: [{ ...v2Project, title: "Refreshed", repositoryIdentity: null }],
    });
    expect(next.projects[0]?.title).toBe("Refreshed");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("authoritative lower-sequence reset replaces client-ahead structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    });

    expect(next.snapshotSequence).toBe(3);
    expect(next.projects[0]?.title).toBe("Server reset");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.threads[0]?.title).toBe("Server thread");
  });

  it("client-ahead survives lower marked enrichment then still resets on unmarked authoritative", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 20,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    const afterEnrichment = mergeShellSnapshotProjects(previous, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(20);
    expect(afterEnrichment.projects[0]?.title).toBe("Client ahead");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Local-only thread");

    const afterAuthoritative = mergeShellSnapshotProjects(afterEnrichment, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");
  });

  it("authoritative null retains identity then same-sequence marked enrichment clears it", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    const afterAuthoritative = mergeShellSnapshotProjects(previous, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");

    const afterEnrichment = mergeShellSnapshotProjects(afterAuthoritative, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(3);
    expect(afterEnrichment.projects[0]?.title).toBe("Server reset");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Server thread");
  });

  it("keeps the project object when an enrichment re-resolves an unchanged identity", () => {
    const project = { ...v2Project, repositoryIdentity };
    const previous = { ...v2ShellSnapshot, snapshotSequence: 5, projects: [project] };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        projects: [{ ...v2Project, repositoryIdentity: { ...repositoryIdentity } }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.projects[0]).toBe(project);
  });

  it("takes identity from a lower-sequence enrichment without reverting live thread state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Newest title" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [{ ...v2ThreadShell, title: "Stale title" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.title).toBe("Newest title");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("treats higher-sequence compact enrichment as metadata-only", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Newest title" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 8,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [],
        archivedThreads: [],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.title).toBe("Newest title");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("lower-sequence enrichment cannot resurrect empty structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 7,
      projects: [],
      threads: [],
      archivedThreads: [],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [v2ThreadShell],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.projects).toEqual([]);
    expect(next.threads).toEqual([]);
  });

  it("resolved null clears identity only for the marked root", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects).toHaveLength(2);
    expect(next.projects[0]?.repositoryIdentity).toBeNull();
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("unrelated unresolved roots retain identity in the same enrichment snapshot", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
      threads: [{ ...v2ThreadShell, title: "Current thread" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity },
          { ...otherProject, repositoryIdentity: null },
        ],
        threads: [{ ...v2ThreadShell, title: "Stale thread" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.threads[0]?.title).toBe("Current thread");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("clears identity for multiple roots resolved in one enrichment batch", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      {
        resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot, otherProject.workspaceRoot],
      },
    );

    expect(next.projects.map((project) => project.repositoryIdentity)).toEqual([null, null]);
  });

  it("does not replace a live identity with one from an unmarked lower-sequence enrichment", () => {
    const liveIdentity = {
      canonicalKey: "github.com/example/live",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/live.git",
      },
    };
    const staleIdentity = {
      canonicalKey: "github.com/example/stale",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/stale.git",
      },
    };
    const next = mergeShellSnapshotProjects(
      {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        projects: [{ ...v2Project, repositoryIdentity: liveIdentity }],
      },
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity: staleIdentity }],
      },
      { resolvedRepositoryIdentityRoots: [] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects[0]?.repositoryIdentity).toEqual(liveIdentity);
  });

  it("keeps archive deltas out of the normal shell cache", () => {
    const archived = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.updated",
      sequence: 3,
      location: "archive",
      thread: { ...v2ThreadShell, archivedAt: v2ThreadShell.updatedAt },
    });
    expect(archived.threads).toEqual([]);
    expect(archived.archivedThreads).toEqual([]);

    const active = applyShellStreamEvent(archived, {
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: v2ThreadShell,
    });
    expect(active.threads).toHaveLength(1);
    expect(active.archivedThreads).toEqual([]);
  });

  it("removes a thread from either collection", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.removed",
      sequence: 5,
      location: "active",
      threadId: ThreadId.make(v2ThreadShell.id),
    });
    expect(next.threads).toEqual([]);
    expect(next.snapshotSequence).toBe(5);
  });

  it("leaves unknown future events unchanged", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "future.event",
      sequence: 99,
    } as never);

    expect(next).toBe(v2ShellSnapshot);
  });
});

describe("reuseUnchangedThreadShells", () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: 3,
    url: "https://github.com/pingdotgg/t3code/pull/3",
    source: "agent",
    linkedAt: "2026-06-20T00:00:00.000Z",
    snapshot: null,
    stack: null,
  };
  const linked = { ...v2ThreadShell, pullRequests: [link] };
  const other = { ...v2ThreadShell, id: ThreadId.make("thread-other"), title: "Other" };

  it("keeps the previous object for an unchanged row, even without its deferred links", () => {
    const previous = { ...v2ShellSnapshot, threads: [linked, other] };
    const { pullRequests: _links, ...withoutLinks } = linked;
    const next = reuseUnchangedThreadShells(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      threads: [withoutLinks, { ...other, title: "Renamed" }],
    });
    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]).toBe(linked);
    expect(next.threads[1]).not.toBe(other);
    expect(next.threads[1]?.title).toBe("Renamed");
  });

  it("returns the incoming snapshot when no row is unchanged", () => {
    const incoming = { ...v2ShellSnapshot, threads: [{ ...other, title: "Renamed" }] };
    expect(reuseUnchangedThreadShells({ ...v2ShellSnapshot, threads: [other] }, incoming)).toBe(
      incoming,
    );
  });
});
