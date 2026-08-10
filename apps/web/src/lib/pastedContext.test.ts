import { describe, expect, it } from "vite-plus/test";

import {
  PASTED_CONTEXT_MAX_CHARS,
  PASTED_CONTEXT_MAX_COUNT,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  appendPastedContextsToPrompt,
  extractTrailingPastedContexts,
  isTextLikeFile,
  makePastedContext,
  newPastedContextId,
  pastedTextLabel,
  readPastedContextFiles,
  shouldConvertPasteToContext,
} from "./pastedContext";

const draft = (name: string, content: string) =>
  makePastedContext({ name, content, fromFile: false });

describe("appendPastedContextsToPrompt / extractTrailingPastedContexts", () => {
  it("round-trips the prompt body and the attachment", () => {
    const sent = appendPastedContextsToPrompt("summarize this", [
      draft("log.txt", "line a\nline b"),
    ]);
    const extracted = extractTrailingPastedContexts(sent);
    expect(extracted.promptText).toBe("summarize this");
    expect(extracted.contextCount).toBe(1);
    expect(extracted.contexts[0]?.name).toBe("log.txt");
    expect(extracted.contexts[0]?.body).toBe("line a\nline b");
    expect(extracted.contexts[0]?.lineCount).toBe(2);
  });

  it("keeps several attachments distinct", () => {
    const sent = appendPastedContextsToPrompt("compare", [
      draft("a.md", "alpha"),
      draft("b.md", "beta"),
    ]);
    const extracted = extractTrailingPastedContexts(sent);
    expect(extracted.contexts.map((entry) => entry.name)).toEqual(["a.md", "b.md"]);
    expect(extracted.contexts.map((entry) => entry.body)).toEqual(["alpha", "beta"]);
  });

  it("supports an attachment with no prompt text", () => {
    const sent = appendPastedContextsToPrompt("", [draft("only.txt", "body")]);
    expect(extractTrailingPastedContexts(sent).promptText).toBe("");
  });

  it("leaves an untouched prompt alone", () => {
    expect(appendPastedContextsToPrompt("plain", [])).toBe("plain");
    const extracted = extractTrailingPastedContexts("plain prompt");
    expect(extracted.promptText).toBe("plain prompt");
    expect(extracted.contextCount).toBe(0);
  });

  it("does not strip a mid-prompt mention of the tag", () => {
    // Only a trailing block is an attachment; prose about it stays prose.
    const text = "explain <pasted_context> semantics to me";
    expect(extractTrailingPastedContexts(text).promptText).toBe(text);
  });

  it("preserves blank lines inside an attachment body", () => {
    const body = "para one\n\npara two";
    const sent = appendPastedContextsToPrompt("x", [draft("doc.md", body)]);
    expect(extractTrailingPastedContexts(sent).contexts[0]?.body).toBe(body);
  });

  it("round-trips content that looks like legacy attachment headers or delimiters", () => {
    const body = [
      "# Incident",
      "- Heading:",
      '{"name":"not metadata","contentLength":500}',
      "<pasted_context>",
      "</pasted_context>",
      "tail",
    ].join("\n");
    const sent = appendPastedContextsToPrompt("inspect", [
      draft('notes "quoted".md', body),
      draft("second.txt", "- Another:\nvalue"),
    ]);

    expect(sent).toContain('<pasted_context version="2">');
    expect(extractTrailingPastedContexts(sent)).toMatchObject({
      promptText: "inspect",
      contextCount: 2,
      contexts: [
        { name: 'notes "quoted".md', body },
        { name: "second.txt", body: "- Another:\nvalue" },
      ],
    });
  });

  it("still renders attachment blocks stored by the legacy format", () => {
    const legacy = "prompt\n\n<pasted_context>\n- old.txt:\nold body\n</pasted_context>";
    expect(extractTrailingPastedContexts(legacy)).toMatchObject({
      promptText: "prompt",
      contextCount: 1,
      contexts: [{ name: "old.txt", body: "old body" }],
    });
  });

  it("rejects a corrupt v2 length instead of inventing partial attachments", () => {
    const corrupt =
      'prompt\n\n<pasted_context version="2">\n{"name":"x","contentLength":99}\nshort\n</pasted_context>';
    expect(extractTrailingPastedContexts(corrupt)).toEqual({
      promptText: corrupt,
      contextCount: 0,
      contexts: [],
    });
  });

  it.each([
    ["malformed metadata", "not-json\nbody"],
    ["missing name", '{"contentLength":4}\nbody'],
    ["negative length", '{"name":"x","contentLength":-1}\n'],
    ["unsafe length", '{"name":"x","contentLength":9007199254740992}\nbody'],
  ])("leaves %s v2 blocks visible instead of fabricating an attachment", (_label, block) => {
    const corrupt = `prompt\n\n<pasted_context version="2">\n${block}\n</pasted_context>`;
    expect(extractTrailingPastedContexts(corrupt)).toEqual({
      promptText: corrupt,
      contextCount: 0,
      contexts: [],
    });
  });
});

describe("makePastedContext", () => {
  it("keeps a large paste inline when all attachment slots are reserved", () => {
    expect(
      shouldConvertPasteToContext({
        textLength: PASTED_TEXT_ATTACHMENT_THRESHOLD,
        existingContextCount: PASTED_CONTEXT_MAX_COUNT,
        pendingContextCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldConvertPasteToContext({
        textLength: PASTED_TEXT_ATTACHMENT_THRESHOLD,
        existingContextCount: PASTED_CONTEXT_MAX_COUNT - 1,
        pendingContextCount: 1,
      }),
    ).toBe(false);
  });

  it("converts only large pastes while an attachment slot is available", () => {
    expect(
      shouldConvertPasteToContext({
        textLength: PASTED_TEXT_ATTACHMENT_THRESHOLD,
        existingContextCount: PASTED_CONTEXT_MAX_COUNT - 1,
        pendingContextCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldConvertPasteToContext({
        textLength: PASTED_TEXT_ATTACHMENT_THRESHOLD - 1,
        existingContextCount: 0,
        pendingContextCount: 0,
      }),
    ).toBe(false);
  });

  it("mints collision-resistant chip ids across a stressed batch", () => {
    const ids = Array.from({ length: 2_000 }, () => newPastedContextId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("paste_"))).toBe(true);
  });

  it("truncates past the cap with an explicit marker", () => {
    const oversized = "x".repeat(PASTED_CONTEXT_MAX_CHARS + 500);
    const made = draft("huge.log", oversized);
    expect(made.content.length).toBeLessThan(oversized.length);
    // The model must never be told it has content it does not.
    expect(made.content).toContain("truncated");
    expect(made.content).toContain("500 more characters");
  });

  it("normalizes CRLF and trims surrounding blank lines", () => {
    expect(draft("f", "\r\n\r\nalpha\r\nbeta\r\n\r\n").content).toBe("alpha\nbeta");
  });

  it("falls back to a name when given none", () => {
    expect(draft("   ", "body").name).toBe("pasted text");
  });

  it("labels a bare paste by line count", () => {
    expect(pastedTextLabel("a\nb\nc")).toBe("Pasted text (3 lines)");
  });
});

describe("isTextLikeFile", () => {
  it("accepts text and source files, including empty-type drops", () => {
    expect(isTextLikeFile({ type: "text/plain", name: "a.txt" })).toBe(true);
    expect(isTextLikeFile({ type: "application/json", name: "a.json" })).toBe(true);
    // Editors and OSes routinely report no type for source files.
    expect(isTextLikeFile({ type: "", name: "server.ts" })).toBe(true);
    expect(isTextLikeFile({ type: "", name: "notes.md" })).toBe(true);
  });

  it("never claims an image, so images keep their own preview path", () => {
    expect(isTextLikeFile({ type: "image/png", name: "shot.png" })).toBe(false);
  });

  it("rejects unknown binaries", () => {
    expect(isTextLikeFile({ type: "application/octet-stream", name: "blob.bin" })).toBe(false);
  });
});

describe("readPastedContextFiles", () => {
  it("isolates unreadable and empty files while preserving successful order", async () => {
    const result = await readPastedContextFiles([
      { name: "one.md", text: async () => "one" },
      { name: "broken.md", text: async () => Promise.reject(new Error("unreadable")) },
      { name: "empty.md", text: async () => "" },
      { name: "two.md", text: async () => "two" },
    ]);
    expect(result.contexts.map((entry) => [entry.name, entry.content])).toEqual([
      ["one.md", "one"],
      ["two.md", "two"],
    ]);
    expect(result.rejectedNames).toEqual(["broken.md", "empty.md"]);
    expect(result.skippedCount).toBe(0);
  });

  it("never reads past the available bounded capacity", async () => {
    const reads: string[] = [];
    const files = Array.from({ length: PASTED_CONTEXT_MAX_COUNT + 5 }, (_, index) => ({
      name: `${index}.txt`,
      text: async () => {
        reads.push(String(index));
        return String(index);
      },
    }));
    const result = await readPastedContextFiles(files, 3);
    expect(reads).toEqual(["0", "1", "2"]);
    expect(result.contexts).toHaveLength(3);
    expect(result.skippedCount).toBe(PASTED_CONTEXT_MAX_COUNT + 2);
  });
});
