import { describe, expect, it } from "vite-plus/test";

import { parseGitCommitFiles, parseGitHistory } from "./GitHistory.ts";

describe("Git history parsing", () => {
  it("parses commits, decorations, and truncation", () => {
    const output =
      "\u001eabc\u001fparent\u001fAda\u001fada@example.com\u001f2026-08-11T12:00:00Z\u001fHEAD -> main, tag: v1\u001fShip it\u001fBody\n" +
      "\u001edef\u001f\u001fLin\u001flin@example.com\u001f2026-08-10T12:00:00Z\u001f\u001fInitial\u001f";
    expect(parseGitHistory(output, "main", 1)).toEqual({
      isRepo: true,
      branch: "main",
      truncated: true,
      commits: [
        {
          sha: "abc",
          parentShas: ["parent"],
          authorName: "Ada",
          authorEmail: "ada@example.com",
          authoredAt: "2026-08-11T12:00:00Z",
          decorations: ["HEAD -> main", "tag: v1"],
          subject: "Ship it",
          body: "Body",
        },
      ],
    });
  });

  it("parses text and binary file stats", () => {
    expect(parseGitCommitFiles("12\t3\tsrc/index.ts\n-\t-\tassets/logo.png\n")).toEqual([
      { path: "src/index.ts", additions: 12, deletions: 3 },
      { path: "assets/logo.png", additions: null, deletions: null },
    ]);
  });
});
