import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeReviewDiffData,
  buildNativeReviewSnippetRows,
  createNativeReviewDiffTheme,
  getCachedNativeReviewDiffData,
  type BuildNativeReviewDiffDataInput,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff } from "./reviewModel";

const parsedDiff = buildReviewParsedDiff(
  [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const before = 1;",
    "+const after = 2;",
  ].join("\n"),
  "native-review-cache-test",
);

describe("buildNativeReviewSnippetRows", () => {
  it("preserves selected code and change types without inventing line numbers", () => {
    const rows = buildNativeReviewSnippetRows({
      id: "selection",
      diff: "  unchanged\r\n-  before\r\n+  after\r\n",
    });
    expect(
      rows.map((row) => [row.content, row.change, row.oldLineNumber, row.newLineNumber]),
    ).toEqual([
      [" unchanged", "context", null, null],
      ["  before", "delete", null, null],
      ["  after", "add", null, null],
    ]);
  });

  it("leaves full patches, unrecognized text, and non-diff code to their existing renderers", () => {
    for (const diff of ["@@ -1 +1 @@\n-old\n+new", "--- a/file\n+++ b/file", "plain text", ""]) {
      expect(buildNativeReviewSnippetRows({ id: "selection", diff })).toEqual([]);
    }
    expect(
      buildNativeReviewSnippetRows({ id: "code", diff: "+value", fenceLanguage: "typescript" }),
    ).toEqual([]);
  });
});

function makeComment(text: string): ReviewInlineComment {
  return {
    id: "comment-1",
    sectionId: "git:working-tree",
    sectionTitle: "Dirty worktree",
    filePath: "example.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "-1",
    text,
    diff: "@@ -1,1 +1,0 @@\n-const before = 1;",
  };
}

function buildInput(comments: BuildNativeReviewDiffDataInput["comments"]) {
  return { parsedDiff, comments } satisfies BuildNativeReviewDiffDataInput;
}

describe("getCachedNativeReviewDiffData", () => {
  it("reuses the row model for equivalent empty comment arrays", () => {
    const first = getCachedNativeReviewDiffData(buildInput([]));
    const second = getCachedNativeReviewDiffData(buildInput([]));

    expect(second).toBe(first);
  });

  it("reuses equivalent comment contents and invalidates changed comments", () => {
    const first = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const equivalent = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const changed = getCachedNativeReviewDiffData(buildInput([makeComment("Changed")]));

    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
  });
});
