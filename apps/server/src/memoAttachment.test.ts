// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeBuiltinMemoryConnector } from "./mcp/toolkits/memory/builtinStore.ts";
import type { LocalMemoConnector } from "./mcp/toolkits/memory/connectors.ts";
import {
  buildMemoAttachmentRecords,
  deleteMemoAttachment,
  listMemoAttachments,
  MEMO_ATTACHMENT_CHUNK_CHARACTERS,
  memoAttachmentSource,
  parseMemoAttachmentDocumentToken,
  persistMemoAttachment,
} from "./memoAttachment.ts";

const DOCUMENT_TOKEN = "memoattachment0123456789abcdef";

describe("Memo-backed composer attachments", () => {
  it("preserves every character across bounded searchable records", () => {
    const content = `HEAD\n${"x".repeat(MEMO_ATTACHMENT_CHUNK_CHARACTERS * 2)}\nTAIL`;
    const records = buildMemoAttachmentRecords({
      documentToken: DOCUMENT_TOKEN,
      name: "trace.log",
      content,
    });

    expect(records.chunks).toHaveLength(3);
    expect(records.chunks.every((chunk) => chunk.text.length < 17_000)).toBe(true);
    const reconstructed = records.chunks
      .map((chunk) => chunk.text.slice(chunk.text.indexOf("\nContent:\n") + 10))
      .join("");
    expect(reconstructed).toBe(content);
    expect(records.manifest.text).toContain(`Manifest token: ${DOCUMENT_TOKEN}manifest`);
  });

  it("never splits an astral Unicode character across chunks", () => {
    const content = `${"a".repeat(MEMO_ATTACHMENT_CHUNK_CHARACTERS - 1)}😀tail`;
    const records = buildMemoAttachmentRecords({
      documentToken: DOCUMENT_TOKEN,
      name: "unicode.txt",
      content,
    });
    const reconstructed = records.chunks
      .map((chunk) => chunk.text.slice(chunk.text.indexOf("\nContent:\n") + 10))
      .join("");

    const chunks = records.chunks.map((chunk) =>
      chunk.text.slice(chunk.text.indexOf("\nContent:\n") + 10),
    );
    const firstChunk = chunks[0]!;
    const secondChunk = chunks[1]!;
    expect(records.chunks[0]?.text).toContain(`Chunk: 1 of ${records.chunks.length}`);
    expect(firstChunk.charCodeAt(firstChunk.length - 1)).not.toBe(0xd83d);
    expect(secondChunk.charCodeAt(0)).not.toBe(0xde00);
    expect(reconstructed).toBe(content);
  });

  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memo-attachment-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it.effect("commits once and retrieves one exact chunk without returning the whole document", () =>
    Effect.gen(function* () {
      const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const content = `${"a".repeat(MEMO_ATTACHMENT_CHUNK_CHARACTERS - 1)}😀last-piece`;
      const records = buildMemoAttachmentRecords({
        documentToken: DOCUMENT_TOKEN,
        name: "large.txt",
        content,
      });
      yield* persistMemoAttachment({
        connector,
        documentToken: DOCUMENT_TOKEN,
        name: "large.txt",
        content,
        project: "d4research",
      });
      yield* persistMemoAttachment({
        connector,
        documentToken: DOCUMENT_TOKEN,
        name: "large.txt",
        content,
        project: "d4research",
      });

      const retrievedChunks = yield* Effect.forEach(records.chunks, (record) =>
        connector.search(record.token, 1, "d4research").pipe(
          Effect.map((found) => {
            expect(found.results).toHaveLength(1);
            expect(found.results[0]?.text).toContain(`Chunk token: ${record.token}`);
            return found.results[0]!.text.slice(
              found.results[0]!.text.indexOf("\nContent:\n") + 10,
            );
          }),
        ),
      );
      expect(retrievedChunks.join("")).toBe(content);
      expect(retrievedChunks[1]).toContain("last-piece");
      expect(retrievedChunks[1]!.length).toBeLessThan(content.length);
      const stats = yield* connector.stats();
      expect(stats.count).toBe(records.chunks.length + 1);
    }),
  );

  it.effect("does not write a commit manifest after a failed chunk", () => {
    const addedTexts: string[] = [];
    let addCount = 0;
    const connector: LocalMemoConnector = {
      search: () => Effect.succeed({ results: [] }),
      add: (text) => {
        addedTexts.push(text);
        addCount += 1;
        return Effect.succeed({ ok: addCount !== 2 });
      },
      stats: () => Effect.succeed({ status: "ok" }),
      health: () => Effect.succeed({ status: "ok" }),
    };

    return persistMemoAttachment({
      connector,
      documentToken: DOCUMENT_TOKEN,
      name: "partial.txt",
      content: "x".repeat(MEMO_ATTACHMENT_CHUNK_CHARACTERS + 1),
      project: "d4research",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("every attachment chunk");
        expect(addedTexts.some((text) => text.includes("Memo attachment manifest"))).toBe(false);
      }),
    );
  });

  it.effect("lists and idempotently deletes only one source-scoped document", () =>
    Effect.gen(function* () {
      const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const deleteToken = "memoattachmentdelete0123456789";
      const keepToken = "memoattachmentkeep0123456789ab";
      const deleteRecords = buildMemoAttachmentRecords({
        documentToken: deleteToken,
        name: "delete-me.txt",
        content: "deletemarker ".repeat(2_000),
      });
      yield* persistMemoAttachment({
        connector,
        documentToken: deleteToken,
        name: "delete-me.txt",
        content: "deletemarker ".repeat(2_000),
        project: "lifecycle",
      });
      yield* persistMemoAttachment({
        connector,
        documentToken: keepToken,
        name: "keep-me.txt",
        content: "keepmarker",
        project: "lifecycle",
      });
      yield* connector.add("handoffmarker", "t3research-provider-handoff", "lifecycle");

      const before = yield* connector.stats();
      const listed = yield* listMemoAttachments(connector);
      expect(listed.supported).toBe(true);
      expect(
        listed.attachments.find((attachment) => attachment.documentToken === deleteToken),
      ).toMatchObject({
        name: "delete-me.txt",
        project: "lifecycle",
        characterCount: "deletemarker ".repeat(2_000).length,
        chunkCount: deleteRecords.chunks.length,
        incomplete: false,
      });

      const deleted = yield* deleteMemoAttachment({ connector, documentToken: deleteToken });
      const deletedAgain = yield* deleteMemoAttachment({ connector, documentToken: deleteToken });
      expect(deleted).toEqual({ supported: true, deleted: deleteRecords.chunks.length + 1 });
      expect(deletedAgain).toEqual({ supported: true, deleted: 0 });

      const after = yield* connector.stats();
      expect((before.count ?? 0) - (after.count ?? 0)).toBe(deleteRecords.chunks.length + 1);
      expect(
        (yield* connector.search(deleteRecords.chunks[0]!.token, 1, "lifecycle")).results,
      ).toEqual([]);
      expect((yield* connector.search("keepmarker", 1, "lifecycle")).results).toHaveLength(1);
      expect((yield* connector.search("handoffmarker", 1, "lifecycle")).results).toHaveLength(1);
    }),
  );

  it.effect("keeps an incomplete write visible so it can be deleted", () =>
    Effect.gen(function* () {
      const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const documentToken = "memoattachmentpartial0123456789";
      const records = buildMemoAttachmentRecords({
        documentToken,
        name: "partial.txt",
        content: "partialmarker",
      });
      yield* connector.add(
        records.chunks[0]!.text,
        memoAttachmentSource(documentToken),
        "lifecycle",
      );

      const listed = yield* listMemoAttachments(connector);
      expect(
        listed.attachments.find((attachment) => attachment.documentToken === documentToken),
      ).toMatchObject({
        name: "partial.txt",
        project: "lifecycle",
        characterCount: "partialmarker".length,
        chunkCount: 1,
        incomplete: true,
      });
    }),
  );

  it("round-trips only valid attachment sources", () => {
    expect(parseMemoAttachmentDocumentToken(memoAttachmentSource(DOCUMENT_TOKEN))).toBe(
      DOCUMENT_TOKEN,
    );
    expect(parseMemoAttachmentDocumentToken("t3research-provider-handoff")).toBeNull();
    expect(parseMemoAttachmentDocumentToken("d4research-composer-attachment:")).toBeNull();
    expect(parseMemoAttachmentDocumentToken("d4research-composer-attachment:invalid")).toBeNull();
  });

  it.effect("returns a typed failure for an invalid deletion token", () =>
    Effect.gen(function* () {
      const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const error = yield* Effect.flip(
        deleteMemoAttachment({ connector, documentToken: "invalid" }),
      );
      expect(error).toMatchObject({
        _tag: "MemoryConnectorError",
        operation: "deleteBySource",
        message: "Invalid Memo attachment document token.",
      });
    }),
  );
});
