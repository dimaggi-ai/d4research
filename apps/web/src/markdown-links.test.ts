import { shouldOpenMarkdownFileLinkInBrowserByDefault } from "./markdown-links";
import { shouldOpenMarkdownFileLinkInEditor } from "./markdown-links";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFilePanelTarget,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

describe("resolveMarkdownFilePanelTarget", () => {
  const roots = [
    { path: "/work/app", label: "Primary directory" },
    { path: "/work/qa-services", label: "QA" },
  ];

  it("opens an absolute secondary-directory link against its owning root", () => {
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/work/qa-services/src/check.ts",
        panelPath: "/work/qa-services/src/check.ts",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: roots,
      }),
    ).toEqual({ path: "src/check.ts", workspaceRoot: "/work/qa-services" });
  });

  it("recognizes a secondary directory name or label at the start of a relative link", () => {
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/work/app/qa-services/src/check.ts",
        panelPath: "qa-services/src/check.ts",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: roots,
      }),
    ).toEqual({ path: "src/check.ts", workspaceRoot: "/work/qa-services" });
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/work/app/QA/src/check.ts",
        panelPath: "QA/src/check.ts",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: roots,
      }),
    ).toEqual({ path: "src/check.ts", workspaceRoot: "/work/qa-services" });
  });

  it("keeps ordinary relative links in the active checkout", () => {
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/work/app/src/main.ts",
        panelPath: "src/main.ts",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: roots,
      }),
    ).toEqual({ path: "src/main.ts", workspaceRoot: "/work/app" });
  });

  it("uses the deepest configured root and leaves external host files absolute", () => {
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/work/app/packages/docs/readme.md",
        panelPath: "/work/app/packages/docs/readme.md",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: [...roots, { path: "/work/app/packages/docs" }],
      }),
    ).toEqual({ path: "readme.md", workspaceRoot: "/work/app/packages/docs" });
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "/tmp/report.md",
        panelPath: "/tmp/report.md",
        preferredWorkspaceRoot: "/work/app",
        workspaceRoots: roots,
      }),
    ).toEqual({ path: "/tmp/report.md" });
  });

  it("supports Windows project roots", () => {
    expect(
      resolveMarkdownFilePanelTarget({
        filePath: "D:\\work\\qa-services\\src\\check.ts",
        panelPath: "D:\\work\\qa-services\\src\\check.ts",
        preferredWorkspaceRoot: "D:\\work\\app",
        workspaceRoots: [{ path: "D:\\work\\qa-services" }],
      }),
    ).toEqual({ path: "src/check.ts", workspaceRoot: "D:\\work\\qa-services" });
  });
});

describe("isWindowsDrivePathHref", () => {
  it.each([
    ["C:\\repo\\image.png", true],
    ["C:%5Crepo%5Cimage.png", true],
    ["https://example.com/image.png", false],
  ])("classifies %s as %s", (href, expected) => {
    expect(isWindowsDrivePathHref(href)).toBe(expected);
  });
});

function renderMarkdownLinkHref(markdown: string): string | undefined {
  let renderedHref: string | undefined;
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        components: {
          a({ href }) {
            renderedHref = href;
            return createElement("a", { href });
          },
        },
      },
      markdown,
    ),
  );
  return renderedHref;
}

describe("extractMarkdownLinkHrefs", () => {
  it("extracts angle-bracketed paths containing spaces", () => {
    expect(
      extractMarkdownLinkHrefs(
        "[Open the Bike Receipts folder](</Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts>)",
      ),
    ).toEqual(["/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts"]);
  });

  it("preserves ordinary destinations and ignores link titles", () => {
    expect(
      extractMarkdownLinkHrefs(
        '[source](apps/web/src/markdown-links.ts "implementation") and [docs](https://example.com)',
      ),
    ).toEqual(["apps/web/src/markdown-links.ts", "https://example.com"]);
  });
});

describe("shouldOpenMarkdownFileLinkInEditor", () => {
  it("uses command-click on macOS", () => {
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(
      true,
    );
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(
      false,
    );
  });

  it("uses control-click on other platforms", () => {
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "Linux x86_64"),
    ).toBe(true);
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "Linux x86_64"),
    ).toBe(false);
  });
});

describe("shouldOpenMarkdownFileLinkInBrowserByDefault", () => {
  it("keeps PDFs browser-first while source files open in the file viewer", () => {
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.pdf")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.PDF?download=1")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.html")).toBe(false);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.xml")).toBe(false);
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  // regression: #6433 workspace images in chat markdown did not render
  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("resolves links from a document directory while keeping workspace-relative preview paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "./report.md",
        "/Users/example/project/docs",
        "/Users/example/project",
      ),
    ).toMatchObject({
      targetPath: "/Users/example/project/docs/report.md",
      workspaceRelativePath: "docs/report.md",
    });
  });

  // The pairing the file preview relies on: a document read from one checkout links to a path
  // relative to that checkout, and the panel opens it against the same root rather than against
  // whichever tree the thread happens to be working in.
  it("keeps a link relative to the document's own workspace root", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "./notes/next.md",
        "/Users/example/project/plans",
        "/Users/example/project",
      ),
    ).toMatchObject({
      targetPath: "/Users/example/project/plans/notes/next.md",
      workspaceRelativePath: "plans/notes/next.md",
    });
    // The same document read from a worktree resolves against the worktree instead.
    expect(
      resolveMarkdownFileLinkMeta(
        "./notes/next.md",
        "/Users/example/worktrees/feature/plans",
        "/Users/example/worktrees/feature",
      ),
    ).toMatchObject({
      targetPath: "/Users/example/worktrees/feature/plans/notes/next.md",
      workspaceRelativePath: "plans/notes/next.md",
    });
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("resolves file uri authorities as windows UNC paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("resolves a localhost file uri as a local path", () => {
    expect(resolveMarkdownFileLinkTarget("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("resolves the encoded spaces emitted by the markdown renderer", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/Users/dara/Downloads/Lime%20Ride%20Artifacts/Bike%20Receipts",
        "/Users/dara/Downloads/Lime Ride Artifacts",
      ),
    ).toMatchObject({
      targetPath: "/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts",
      workspaceRelativePath: "Bike Receipts",
      basename: "Bike Receipts",
    });
  });

  it("resolves relative spaced folders from the markdown renderer", () => {
    const href = renderMarkdownLinkHref("[folder](<docs/My Folder>)");

    expect(href).toBe("docs/My%20Folder");
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      targetPath: "/repo/project/docs/My Folder",
      workspaceRelativePath: "docs/My Folder",
      basename: "My Folder",
    });
  });

  it.each(["md", "html", "xml"])(
    "resolves a bare spaced .%s filename from the markdown renderer",
    (extension) => {
      const href = renderMarkdownLinkHref(`[checklist](<Updated cutover checklist.${extension}>)`);

      expect(href).toBe(`Updated%20cutover%20checklist.${extension}`);
      expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
        targetPath: `/repo/project/Updated cutover checklist.${extension}`,
        workspaceRelativePath: `Updated cutover checklist.${extension}`,
        basename: `Updated cutover checklist.${extension}`,
      });
    },
  );

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("does not classify a case-distinct POSIX sibling as a workspace file", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/tmp/t3code-case-test/project/probe.txt",
        "/tmp/t3code-case-test/Project",
      ),
    ).toMatchObject({
      displayPath: "/tmp/t3code-case-test/project/probe.txt",
      workspaceRelativePath: null,
    });
  });

  it("keeps Windows workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:/Users/MIKE/Project/src/main.ts", "c:/users/mike/project"),
    ).toMatchObject({
      displayPath: "project/src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it("keeps drive-root workspace comparisons case-insensitive", () => {
    expect(resolveMarkdownFileLinkMeta("C:/Users/MIKE/project.ts", "c:/")).toMatchObject({
      displayPath: "c:/Users/MIKE/project.ts",
      workspaceRelativePath: "Users/MIKE/project.ts",
    });
  });

  it("keeps backslash UNC workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "\\\\server\\share\\PROJECT\\src\\main.ts",
        "\\\\Server\\Share\\Project",
      ),
    ).toMatchObject({
      displayPath: "Project/src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it.each([
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/file.ts", "c:/", "Users/MIKE/file.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts%20", "/tmp/repo", "file.ts "],
  ])("preserves the preview target for %s in workspace %s", (href, cwd, workspaceRelativePath) => {
    expect(resolveMarkdownFileLinkMeta(href, cwd)).toMatchObject({ workspaceRelativePath });
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links, even with a line anchor", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("/chat/settings#L3", "/repo")).toBeNull();
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

it("does not reinterpret an explicit absolute file as a secondary-directory alias", () => {
  const meta = resolveMarkdownFileLinkMeta("/Users/me/app/backend/report.md#L4", "/Users/me/app")!;
  expect(meta.absoluteReference).toBe(true);
  expect(
    resolveMarkdownFilePanelTarget({
      filePath: meta.filePath,
      panelPath: meta.absoluteReference ? meta.filePath : meta.workspaceRelativePath!,
      preferredWorkspaceRoot: "/Users/me/app",
      workspaceRoots: [{ path: "/Users/me/app" }, { path: "/Users/me/backend", label: "backend" }],
    }),
  ).toEqual({ path: "backend/report.md", workspaceRoot: "/Users/me/app" });
  expect(meta.line).toBe(4);
});

it("preserves a link to a different worktree as an absolute host file", () => {
  const meta = resolveMarkdownFileLinkMeta(
    "/Users/me/worktrees/other/report.md",
    "/Users/me/worktrees/current",
  )!;
  expect(
    resolveMarkdownFilePanelTarget({
      filePath: meta.filePath,
      panelPath: meta.filePath,
      preferredWorkspaceRoot: "/Users/me/worktrees/current",
      workspaceRoots: [{ path: "/Users/me/project" }],
    }),
  ).toEqual({ path: "/Users/me/worktrees/other/report.md" });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
