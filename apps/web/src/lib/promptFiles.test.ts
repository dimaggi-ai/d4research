import { RESEARCH_PROMPT_FILE_MAX_CHARS, RESEARCH_PROMPT_FILE_MAX_COUNT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergePromptFiles } from "./promptFiles";

describe("mergePromptFiles", () => {
  it("isolates unreadable, unsupported, and oversized files without losing valid ones", async () => {
    const result = await mergePromptFiles(
      [],
      [
        { name: "rules.md", text: async () => "use primary sources" },
        { name: "secret.bin", text: async () => "binary" },
        { name: "broken.txt", text: async () => Promise.reject(new Error("denied")) },
        { name: "huge.txt", text: async () => "x".repeat(RESEARCH_PROMPT_FILE_MAX_CHARS + 1) },
        { name: "review.markdown", text: async () => "review hard" },
      ],
    );
    expect(result.promptFiles).toEqual([
      { name: "rules.md", content: "use primary sources" },
      { name: "review.markdown", content: "review hard" },
    ]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join(" ")).toContain("secret.bin");
    expect(result.errors.join(" ")).toContain("broken.txt");
    expect(result.errors.join(" ")).toContain("huge.txt");
  });

  it("replaces an existing file at capacity but never reads a new overflow file", async () => {
    const existing = Array.from({ length: RESEARCH_PROMPT_FILE_MAX_COUNT }, (_, index) => ({
      name: `${index}.txt`,
      content: `old-${index}`,
    }));
    let overflowReads = 0;
    const result = await mergePromptFiles(existing, [
      { name: "3.txt", text: async () => "replacement" },
      {
        name: "overflow.txt",
        text: async () => {
          overflowReads += 1;
          return "must not be read";
        },
      },
    ]);
    expect(result.promptFiles).toHaveLength(RESEARCH_PROMPT_FILE_MAX_COUNT);
    expect(result.promptFiles[3]).toEqual({ name: "3.txt", content: "replacement" });
    expect(overflowReads).toBe(0);
    expect(result.errors).toEqual([
      `"overflow.txt" skipped — at most ${RESEARCH_PROMPT_FILE_MAX_COUNT} prompt files.`,
    ]);
  });
});
