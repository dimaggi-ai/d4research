import { describe, expect, it, vi } from "vite-plus/test";

import type { PastedContextDraft } from "./lib/pastedContext";
import {
  memoAttachmentDocumentToken,
  pastedContextsNeedMemo,
  prepareMemoPastedContextsForSend,
  replacePastedContextsWithMemoReferences,
} from "./memoAttachments";

function context(overrides: Partial<PastedContextDraft> = {}): PastedContextDraft {
  return {
    id: "paste_0123456789abcdef0123456789abcdef",
    name: "trace.log",
    content: "preview",
    fromFile: true,
    ...overrides,
  };
}

describe("Memo-backed composer attachments", () => {
  it("uses identity-and-content-bound stable FTS-safe document tokens", () => {
    const first = memoAttachmentDocumentToken("d4research\0trace.log", "content");
    expect(first).toBe(memoAttachmentDocumentToken("d4research\0trace.log", "content"));
    expect(first).toMatch(/^memoattachment[a-z0-9]{16,80}$/);
    expect(first).not.toBe(memoAttachmentDocumentToken("other\0trace.log", "content"));
    expect(first).not.toBe(memoAttachmentDocumentToken("d4research\0trace.log", "changed content"));
  });

  it("requires Memo for an in-memory full source or a combined overflow", () => {
    expect(
      pastedContextsNeedMemo({
        contexts: [context({ sourceContent: "complete text" })],
        renderedTextLength: 100,
        maxChars: 1_000,
      }),
    ).toBe(true);
    expect(
      pastedContextsNeedMemo({
        contexts: [context()],
        renderedTextLength: 1_001,
        maxChars: 1_000,
      }),
    ).toBe(true);
    expect(
      pastedContextsNeedMemo({
        contexts: [context()],
        renderedTextLength: 999,
        maxChars: 1_000,
      }),
    ).toBe(false);
    expect(
      pastedContextsNeedMemo({ contexts: [], renderedTextLength: 2_000, maxChars: 1_000 }),
    ).toBe(false);
  });

  it("persists the full source and sends bounded document-scoped search instructions", async () => {
    const sourceContent = `HEAD-${"x".repeat(132_267)}-TAIL`;
    const persist = vi.fn(async (input) => ({
      documentToken: input.documentToken,
      characterCount: input.content.length,
      chunkCount: 9,
    }));

    const [prepared] = await replacePastedContextsWithMemoReferences({
      contexts: [context({ content: "truncated preview", sourceContent, contentTruncated: true })],
      project: "d4research",
      persist,
    });

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        documentToken: memoAttachmentDocumentToken("d4research\0trace.log", sourceContent),
        content: sourceContent,
        project: "d4research",
      }),
    );
    expect(prepared?.content).toContain("complete attachment is preserved in local Memo");
    expect(prepared?.content).toContain("When memory_attachment_search is available");
    expect(prepared?.content).toContain('status is "missing" or "incomplete"');
    expect(prepared?.content).toContain("If memory_attachment_search is unavailable");
    expect(prepared?.content).toContain('project="d4research"');
    expect(prepared?.content).toContain("documentToken=");
    expect(prepared?.content).toContain('query="keywords describing the evidence you need"');
    expect(prepared?.content).not.toContain("then increment");
    expect(prepared?.content).toContain("HEAD-");
    expect(prepared?.content).toContain("-TAIL");
    expect(prepared?.content.length).toBeLessThan(5_000);
    expect(prepared?.sourceContent).toBeUndefined();
  });

  it("persists identical attachments only once within one send", async () => {
    const sourceContent = "same complete document";
    const persist = vi.fn(async (input) => ({
      documentToken: input.documentToken,
      characterCount: input.content.length,
      chunkCount: 1,
    }));

    const prepared = await replacePastedContextsWithMemoReferences({
      contexts: [
        context({ id: "paste_first", sourceContent }),
        context({ id: "paste_second", sourceContent }),
      ],
      project: "d4research",
      persist,
    });

    expect(persist).toHaveBeenCalledOnce();
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.id).toBe("paste_first");
    expect(prepared[1]?.id).toBe("paste_second");
    expect(prepared[0]?.content).toBe(prepared[1]?.content);
  });

  it("does not send a truncated persisted preview after a reload", async () => {
    const persist = vi.fn();
    await expect(
      replacePastedContextsWithMemoReferences({
        contexts: [context({ contentTruncated: true })],
        project: "d4research",
        persist,
      }),
    ).rejects.toThrow('Remove the stale "trace.log" attachment, then reattach it');
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not split astral Unicode characters at preview boundaries", async () => {
    const sourceContent = `${"a".repeat(1_999)}😀${"b".repeat(1_000)}😀${"c".repeat(1_999)}`;
    const [prepared] = await replacePastedContextsWithMemoReferences({
      contexts: [context({ sourceContent })],
      project: "d4research",
      persist: async (input) => ({
        documentToken: input.documentToken,
        characterCount: input.content.length,
        chunkCount: 1,
      }),
    });

    expect(prepared?.content).not.toContain("\ud83d");
    expect(prepared?.content).not.toContain("\ude00");
  });

  it("propagates Memo persistence failure without manufacturing a reference", async () => {
    const persist = vi.fn(async () => {
      throw new Error("Memo is disabled");
    });
    await expect(
      replacePastedContextsWithMemoReferences({
        contexts: [context({ content: "complete small attachment" })],
        project: "d4research",
        persist,
      }),
    ).rejects.toThrow("Memo is disabled");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("releases the send latch after failure so the same page can retry", async () => {
    const sourceContent = `HEAD-${"x".repeat(132_267)}-TAIL`;
    let sendLatched = false;
    const pendingStates: boolean[] = [];
    const onPreparingChange = (preparing: boolean) => {
      sendLatched = preparing;
      pendingStates.push(preparing);
    };

    await expect(
      prepareMemoPastedContextsForSend({
        contexts: [context({ sourceContent })],
        project: "d4research",
        persist: async () => {
          throw new Error("Memo unavailable");
        },
        onPreparingChange,
      }),
    ).rejects.toThrow("Memo unavailable");
    expect(sendLatched).toBe(false);

    const retried = await prepareMemoPastedContextsForSend({
      contexts: [context({ sourceContent })],
      project: "d4research",
      persist: async (input) => ({
        documentToken: input.documentToken,
        characterCount: input.content.length,
        chunkCount: 9,
      }),
      onPreparingChange,
    });
    expect(sendLatched).toBe(false);
    expect(retried[0]?.content.length).toBeLessThan(5_000);
    expect(pendingStates).toEqual([true, false, true, false]);
  });
});
