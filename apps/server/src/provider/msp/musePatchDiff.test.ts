import { describe, expect, it } from "vite-plus/test";
import { patchBodyToUnifiedDiff } from "./musePatchDiff.ts";

const cwd = "/work/project";

describe("patchBodyToUnifiedDiff", () => {
  it("converts a modify hunk with workspace-relative headers", () => {
    expect(
      patchBodyToUnifiedDiff(
        {
          files: [
            {
              hunks: [
                {
                  lines: ["-Alpha line one", "+Beta line one"],
                  newLines: 1,
                  newStart: 1,
                  oldLines: 1,
                  oldStart: 1,
                },
              ],
              path: "/work/project/notes.txt",
            },
          ],
        },
        cwd,
      ),
    ).toBe("--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-Alpha line one\n+Beta line one");
  });

  it("marks added files with /dev/null and deleted files the same way", () => {
    expect(
      patchBodyToUnifiedDiff(
        {
          files: [
            {
              hunks: [
                { lines: ["+hello new"], newLines: 1, newStart: 1, oldLines: 0, oldStart: 1 },
              ],
              path: "newfile.txt",
            },
            {
              hunks: [{ lines: ["-bye"], newLines: 0, newStart: 1, oldLines: 1, oldStart: 1 }],
              path: "gone.txt",
            },
          ],
        },
        cwd,
      ),
    ).toBe(
      "--- /dev/null\n+++ b/newfile.txt\n@@ -1,0 +1,1 @@\n+hello new\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-bye",
    );
  });

  it("represents renames with the old and new header pair", () => {
    expect(
      patchBodyToUnifiedDiff(
        {
          files: [
            {
              hunks: [{ lines: [" same"], newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }],
              newPath: "renamed.txt",
              oldPath: "oldname.txt",
            },
          ],
        },
        cwd,
      ),
    ).toBe("--- a/oldname.txt\n+++ b/renamed.txt\n@@ -1,1 +1,1 @@\n same");
  });

  it("returns undefined for bodies without file changes", () => {
    expect(patchBodyToUnifiedDiff(null, cwd)).toBeUndefined();
    expect(patchBodyToUnifiedDiff({}, cwd)).toBeUndefined();
    expect(patchBodyToUnifiedDiff({ files: [] }, cwd)).toBeUndefined();
    expect(
      patchBodyToUnifiedDiff({ files: [{ hunks: [], path: "same.txt" }] }, cwd),
    ).toBeUndefined();
  });
});
