import { describe, expect, it } from "vite-plus/test";

import {
  directChildProjectEntries,
  fileBreadcrumbChildren,
  fileBreadcrumbs,
  firstFileInDirectory,
  parentDirectoryPath,
  workspaceDocumentDirectory,
  breadcrumbPathOf,
  isListableHostFolder,
  retainedBreadcrumbTrail,
} from "./filePath";

describe("fileBreadcrumbs", () => {
  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:\\", kind: "directory" },
      { label: "Temp", path: "C:\\Temp", kind: "directory" },
      { label: "report.md", path: "C:\\Temp\\report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "\\\\server\\share\\report.md").map((c) => c.path)).toEqual([
      "\\\\server",
      "\\\\server\\share",
      "\\\\server\\share\\report.md",
    ]);
  });

  it("builds home-relative breadcrumbs with navigable folders", () => {
    expect(fileBreadcrumbs("t3code", "~/.claude/CLAUDE.md")).toEqual([
      { label: "~", path: "~/", kind: "directory" },
      { label: ".claude", path: "~/.claude", kind: "directory" },
      { label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", kind: "file" },
    ]);
    expect(isListableHostFolder("~/")).toBe(true);
    expect(isListableHostFolder("~/.claude")).toBe(true);
  });

  it("keeps a project folder named ~ inside the project", () => {
    expect(fileBreadcrumbs("t3code", "~").map((crumb) => crumb.path)).toEqual(["", "~"]);
  });
});

describe("breadcrumbPathOf", () => {
  it("keeps the home root listable", () => {
    expect(breadcrumbPathOf("~/")).toBe("~/");
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    ["C:\\Temp\\a", "", ""],
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
    ["C:\\Users\\me\\scope", "C:\\", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "C:\\Users", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "D:\\", "D:\\"],
    ["\\\\nas\\share\\docs\\notes", "\\\\nas\\share", "\\\\nas\\share\\docs\\notes"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });
});

describe("project file navigation helpers", () => {
  const entries = [
    { path: "README.md", kind: "file" },
    { path: "apps", kind: "directory" },
    { path: "apps/web", kind: "directory" },
    { path: "apps/web/package.json", kind: "file" },
    { path: "apps/web/src", kind: "directory" },
    { path: "apps/web/src/main.tsx", kind: "file" },
    { path: "apps/web/src/router.ts", kind: "file" },
    { path: "packages", kind: "directory" },
    { path: "packages/shared", kind: "directory" },
    { path: "packages/shared/src", kind: "directory" },
    { path: "packages/shared/src/index.ts", kind: "file" },
  ] as const;

  it("resolves the parent directory path for a file", () => {
    expect(parentDirectoryPath("apps/web/src/main.tsx")).toBe("apps/web/src");
    expect(parentDirectoryPath("README.md")).toBe("");
  });

  it("resolves the directory containing a workspace document", () => {
    expect(workspaceDocumentDirectory("/Users/example/project", "docs/index.md")).toBe(
      "/Users/example/project/docs",
    );
    expect(workspaceDocumentDirectory("/Users/example/project/", "README.md")).toBe(
      "/Users/example/project",
    );
    expect(workspaceDocumentDirectory("C:\\work\\project", "docs/index.md")).toBe(
      "C:\\work\\project\\docs",
    );
  });

  it("returns only direct children of a directory, with directories first", () => {
    expect(directChildProjectEntries(entries, "apps/web")).toEqual([
      { path: "apps/web/src", kind: "directory" },
      { path: "apps/web/package.json", kind: "file" },
    ]);
    expect(directChildProjectEntries(entries, "")).toEqual([
      { path: "apps", kind: "directory" },
      { path: "packages", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);
  });

  it("finds the first file under a directory", () => {
    expect(firstFileInDirectory(entries, "apps/web/src")).toBe("apps/web/src/main.tsx");
    expect(firstFileInDirectory(entries, "packages")).toBe("packages/shared/src/index.ts");
    expect(firstFileInDirectory(entries, "missing")).toBeNull();
  });
});

it("anchors host Markdown links to the actual host directory", () => {
  expect(workspaceDocumentDirectory("/repo/current", "/tmp/reports/summary.md")).toBe(
    "/tmp/reports",
  );
  expect(workspaceDocumentDirectory("/repo/current", "/repo/other-worktree/docs/plan.md")).toBe(
    "/repo/other-worktree/docs",
  );
  expect(workspaceDocumentDirectory("/repo/current", "/report.md")).toBe("/");
  expect(workspaceDocumentDirectory("C:\\repo\\current", "D:\\reports\\plan.md")).toBe(
    "D:\\reports",
  );
});
