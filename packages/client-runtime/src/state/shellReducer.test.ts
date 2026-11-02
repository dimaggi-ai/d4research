import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type ThreadPullRequestLink,
} from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  applyShellStreamEvent,
  createShellStreamEventReducer,
  applyShellStreamEvents,
  type ShellStreamEvent,
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

  it("authoritative lower-sequence reset replaces client-ahead structural state", () => {
    const unchanged = { ...v2Project, id: ProjectId.make("project-unchanged"), repositoryIdentity };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }, unchanged],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [
        { ...v2Project, title: "Server reset", repositoryIdentity: null },
        { ...unchanged, scripts: [...unchanged.scripts] },
      ],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    });

    expect(next.snapshotSequence).toBe(3);
    expect(next.projects[0]?.title).toBe("Server reset");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.projects[1]).toBe(unchanged);
    expect(
      mergeShellSnapshotProjects(next, { ...v2ShellSnapshot, projects: [...next.projects] })
        .projects,
    ).toBe(next.projects);
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

  it("retains deferred links when the only row changes status", () => {
    const { pullRequests: _links, ...withoutLinks } = linked;
    const next = reuseUnchangedThreadShells(
      { ...v2ShellSnapshot, threads: [linked] },
      {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        threads: [{ ...withoutLinks, status: "running" }],
      },
    );
    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.status).toBe("running");
    expect(next.threads[0]?.pullRequests).toBe(linked.pullRequests);
  });

  it("keeps an explicit link removal when metadata also changes", () => {
    const updated = { ...linked, title: "Renamed", pullRequests: [] };
    const incoming = { ...v2ShellSnapshot, threads: [updated] };
    const next = reuseUnchangedThreadShells({ ...v2ShellSnapshot, threads: [linked] }, incoming);
    expect(next).toBe(incoming);
    expect(next.threads[0]?.pullRequests).toEqual([]);
  });
});

describe("applyShellStreamEvents", () => {
  const row = (id: string) => ({ ...v2ThreadShell, id: ThreadId.make(id) });
  const a = row("a");
  const b = row("b");
  const unchanged = row("unchanged");
  const archived = row("archived");
  const oldArchive = row("old-archive");
  const added = row("new");
  const update = (
    sequence: number,
    thread: typeof v2ThreadShell,
    location: "active" | "archive" = "active",
  ): ShellStreamEvent => ({ kind: "thread.updated", sequence, location, thread });
  const remove = (sequence: number, thread: typeof v2ThreadShell): ShellStreamEvent => ({
    kind: "thread.removed",
    sequence,
    location: "active",
    threadId: thread.id,
  });

  it("matches sequential mixed deltas, including remove/reinsert order and stale events", () => {
    const otherProject = { ...v2Project, id: ProjectId.make("other-project") };
    const seed = {
      ...v2ShellSnapshot,
      snapshotSequence: 4,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
      threads: [a, b, unchanged],
      archivedThreads: [archived, oldArchive],
    };
    const events: Array<ShellStreamEvent> = [
      update(5, { ...b, title: "Renamed" }),
      remove(5, a),
      remove(6, a),
      update(7, a),
      update(8, b, "archive"),
      update(9, archived),
      update(10, oldArchive, "archive"),
      update(11, added),
      remove(12, { ...a, id: ThreadId.make("missing") }),
      remove(11, added),
      remove(13, added),
      update(14, added),
      update(15, { ...archived }),
      { kind: "project.updated", sequence: 16, project: { ...v2Project, title: "Updated" } },
      { kind: "project.updated", sequence: 17, project: { ...v2Project, workspaceRoot: "/moved" } },
      { kind: "project.removed", sequence: 18, projectId: v2Project.id },
      { kind: "project.updated", sequence: 19, project: v2Project },
    ];
    const sequential = events.reduce<OrchestrationV2ShellSnapshot>(
      (current, event) => applyShellStreamEvent(current, event),
      seed,
    );
    const next = applyShellStreamEvents(seed, events);
    expect(next).toEqual(sequential);
    expect(next.threads.map((row) => row.id)).toEqual([unchanged.id, a.id, archived.id, added.id]);
    expect(next.threads[0]).toBe(unchanged);
    expect(next.threads[2]).toBe(archived);
    expect(next.projects[0]).toBe(otherProject);
    expect(next.archivedThreads).toEqual([]);
    expect(seed.threads).toEqual([a, b, unchanged]);
    expect(seed.archivedThreads).toEqual([archived, oldArchive]);
    // Identity retention must use the latest project in this batch.
    expect(applyShellStreamEvents(seed, events.slice(0, 14)).projects[0]?.repositoryIdentity).toBe(
      repositoryIdentity,
    );
    expect(
      applyShellStreamEvents(seed, events.slice(0, 15)).projects[0]?.repositoryIdentity,
    ).toBeNull();
  });

  it("keeps collection identities for equal rows and rejects stale deltas without indexing", () => {
    const seed = { ...v2ShellSnapshot, threads: [a, b], snapshotSequence: 4 };
    const next = applyShellStreamEvents(seed, [update(5, { ...a }), update(6, { ...b })]);
    expect(next).toEqual(
      [update(5, { ...a }), update(6, { ...b })].reduce<OrchestrationV2ShellSnapshot>(
        (current, event) => applyShellStreamEvent(current, event),
        seed,
      ),
    );
    expect(next.threads).toBe(seed.threads);
    expect(next.projects).toBe(seed.projects);
    expect(next.archivedThreads).toBe(seed.archivedThreads);
    expect(next.snapshotSequence).toBe(6);
    expect(applyShellStreamEvents(seed, [remove(3, a), update(4, b)])).toBe(seed);
    expect(applyShellStreamEvents(seed, [])).toBe(seed);
  });

  it("does not advance the cursor for an unknown future event", () => {
    const events = [
      { kind: "future.event", sequence: 99 } as never,
      update(1, { ...a, title: "Changed" }),
    ];
    expect(applyShellStreamEvents(v2ShellSnapshot, events)).toEqual(
      events.reduce((current, event) => applyShellStreamEvent(current, event), v2ShellSnapshot),
    );
  });
});

describe("batched monitor updates", () => {
  it("retains newer monitor reports across a structural batch", () => {
    const reducer = createShellStreamEventReducer();
    const seed = {
      ...v2ShellSnapshot,
      threads: [{ ...v2ThreadShell, agentMonitor: null, agentMonitorRevision: 5 }],
      snapshotSequence: 0,
    };
    const events = [
      {
        kind: "thread.updated" as const,
        sequence: 1,
        location: "active" as const,
        thread: { ...v2ThreadShell, agentMonitorRevision: 0 },
      },
      { kind: "project.updated" as const, sequence: 2, project: v2Project },
    ];
    const result = reducer.applyBatch(seed, events);
    expect(result.threads[0]?.agentMonitorRevision).toBe(5);
    expect(result.snapshotSequence).toBe(2);
  });
});
