import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadWorkspaces,
  threadWorkspaceInstructions,
} from "@d4research/shared/threadWorkspaces";
import { resolveFilePreviewRoots, resolveFileWorktreeOptions } from "./filePreviewRoots";

describe("resolveFilePreviewRoots", () => {
  it("replaces the primary project checkout with the thread worktree", () => {
    expect(
      resolveFilePreviewRoots("/worktrees/project/task", [
        { path: "/repos/project", label: "Primary directory", color: "blue" },
        { path: "/repos/services", label: "Services", color: "green" },
      ]),
    ).toEqual([
      { path: "/worktrees/project/task", label: "Primary directory", color: "blue" },
      { path: "/repos/services", label: "Services", color: "green" },
    ]);
  });

  it("keeps configured secondary roots when the primary checkout is already active", () => {
    expect(
      resolveFilePreviewRoots("/repos/project", [
        { path: "/repos/project", label: "Primary directory" },
        { path: "/repos/services", label: "Services" },
      ]),
    ).toEqual([
      { path: "/repos/project", label: "Primary directory" },
      { path: "/repos/services", label: "Services" },
    ]);
  });

  it("uses the active checkout when the project has no configured root list", () => {
    expect(resolveFilePreviewRoots("/repos/project", undefined)).toEqual([
      { path: "/repos/project", label: "Primary directory" },
    ]);
  });
});

describe("resolveFileWorktreeOptions", () => {
  it("lists live worktrees by newest commit", () => {
    expect(
      resolveFileWorktreeOptions("/worktrees/project/task-b", [
        {
          name: "main",
          current: false,
          worktreePath: "/repos/project",
          lastCommitAt: 200,
        },
        {
          name: "feature/task-a",
          current: false,
          worktreePath: "/worktrees/project/task-a",
          lastCommitAt: 300,
        },
        {
          name: "feature/task-b",
          current: true,
          worktreePath: "/worktrees/project/task-b",
          lastCommitAt: 100,
        },
        {
          name: "origin/main",
          current: false,
          worktreePath: null,
          lastCommitAt: 400,
        },
      ]),
    ).toEqual([
      {
        path: "/worktrees/project/task-a",
        refName: "feature/task-a",
        current: false,
        lastCommitAt: 300,
      },
      { path: "/repos/project", refName: "main", current: false, lastCommitAt: 200 },
      {
        path: "/worktrees/project/task-b",
        refName: "feature/task-b",
        current: true,
        lastCommitAt: 100,
      },
    ]);
  });

  it("keeps a standalone active checkout available", () => {
    expect(resolveFileWorktreeOptions("/multiwork/project-copy/", [])).toEqual([
      {
        path: "/multiwork/project-copy/",
        refName: null,
        current: true,
        lastCommitAt: null,
      },
    ]);
  });

  it("deduplicates equivalent paths with trailing separators", () => {
    expect(
      resolveFileWorktreeOptions("/repos/project/", [
        {
          name: "main",
          current: true,
          worktreePath: "/repos/project",
          lastCommitAt: 100,
        },
      ]),
    ).toEqual([
      {
        path: "/repos/project",
        refName: "main",
        current: true,
        lastCommitAt: 100,
      },
    ]);
  });
});

describe("per-repository thread selections", () => {
  const project = {
    workspaceRoot: "/frontend",
    workspaceRoots: [
      { path: "/backend", label: "Backend", color: "green" as const },
      { path: "/frontend", label: "Frontend" },
      { path: "/tools" },
    ],
  };
  it("uses configured identities independently of the selected checkout", () => {
    const roots = resolveThreadWorkspaces(project, {
      worktreePath: "/worktrees/frontend",
      branch: "ui",
      workspaceSelections: [
        { workspaceRoot: "/backend", cwd: "/worktrees/backend", branch: "api" },
        { workspaceRoot: "/unconfigured", cwd: "/elsewhere", branch: "bad" },
      ],
    });
    expect(roots.map((r) => [r.workspaceRoot, r.path, r.branch, r.primary])).toEqual([
      ["/frontend", "/worktrees/frontend", "ui", true],
      ["/backend", "/worktrees/backend", "api", false],
      ["/tools", "/tools", null, false],
    ]);
    expect(roots[1]?.color).toBe("green");
    expect(threadWorkspaceInstructions(roots, true)).toContain("thread_workspace_select");
    expect(threadWorkspaceInstructions(roots, true)).toContain(
      "selected cwd /worktrees/backend; branch api",
    );
  });
  it("synthesizes a missing primary root and uses configured roots as defaults", () => {
    expect(
      resolveThreadWorkspaces(
        { workspaceRoot: "/main", workspaceRoots: [{ path: "/other" }] },
        { worktreePath: null, branch: null },
      ).map((r) => r.path),
    ).toEqual(["/main", "/other"]);
  });
});
