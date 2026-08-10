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
  MEMO_ATTACHMENT_CHUNK_CHARACTERS,
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
});
