import { expect, it } from "@effect/vitest";
import { proposalDiff } from "./proposalDiff.ts";

it("renders insertion, deletion, unchanged content and missing final newlines", () => {
  expect(proposalDiff("a.md", "keep\n", "keep\nadded\n")).toBe(
    "--- a/a.md\n+++ b/a.md\n@@ -1,0 +2,1 @@\n+added\n",
  );
  expect(proposalDiff("a.md", "removed\nkeep\n", "keep\n")).toBe(
    "--- a/a.md\n+++ b/a.md\n@@ -1,1 +0,0 @@\n-removed\n",
  );
  expect(proposalDiff("a.md", "same", "same")).toBe("");
  expect(proposalDiff("a.md", "", "new")).toBe(
    "--- a/a.md\n+++ b/a.md\n@@ -0,0 +1,1 @@\n+new\n\\ No newline at end of file\n",
  );
});
