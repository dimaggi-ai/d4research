import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { LocalMemoConnector, MemoryConnectorError } from "./mcp/toolkits/memory/connectors.ts";

export const MEMO_ATTACHMENT_MAX_CHARACTERS = 2_000_000;
export const MEMO_ATTACHMENT_CHUNK_CHARACTERS = 16_000;
export const MEMO_ATTACHMENT_SOURCE = "d4research-composer-attachment";

const MEMO_ATTACHMENT_TOKEN_PATTERN = /^memoattachment[a-z0-9]{16,80}$/;

export interface MemoAttachmentRecord {
  readonly token: string;
  readonly text: string;
}

export interface MemoAttachmentRecords {
  readonly documentToken: string;
  readonly manifestToken: string;
  readonly characterCount: number;
  readonly chunks: ReadonlyArray<MemoAttachmentRecord>;
  readonly manifest: MemoAttachmentRecord;
}

export interface PersistedMemoAttachment {
  readonly documentToken: string;
  readonly characterCount: number;
  readonly chunkCount: number;
}

export class MemoAttachmentPersistenceError extends Data.TaggedError(
  "MemoAttachmentPersistenceError",
)<{ readonly message: string }> {}

export function isMemoAttachmentDocumentToken(value: string): boolean {
  return MEMO_ATTACHMENT_TOKEN_PATTERN.test(value);
}

export function memoAttachmentChunkToken(documentToken: string, index: number): string {
  return `${documentToken}chunk${String(index + 1).padStart(4, "0")}`;
}

function memoAttachmentSource(documentToken: string): string {
  return `${MEMO_ATTACHMENT_SOURCE}:${documentToken}`;
}

interface MemoAttachmentSlice {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function splitMemoAttachmentContent(content: string): ReadonlyArray<MemoAttachmentSlice> {
  const slices: MemoAttachmentSlice[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + MEMO_ATTACHMENT_CHUNK_CHARACTERS);
    if (end < content.length) {
      const precedingCodeUnit = content.charCodeAt(end - 1);
      const followingCodeUnit = content.charCodeAt(end);
      const splitsSurrogatePair =
        precedingCodeUnit >= 0xd800 &&
        precedingCodeUnit <= 0xdbff &&
        followingCodeUnit >= 0xdc00 &&
        followingCodeUnit <= 0xdfff;
      if (splitsSurrogatePair) end -= 1;
    }
    slices.push({ start, end, content: content.slice(start, end) });
    start = end;
  }
  return slices;
}

function buildChunkText(input: {
  readonly documentToken: string;
  readonly chunkToken: string;
  readonly name: string;
  readonly content: string;
  readonly start: number;
  readonly end: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly characterCount: number;
}): string {
  return [
    "d4research Memo attachment chunk.",
    `Document token: ${input.documentToken}`,
    `Chunk token: ${input.chunkToken}`,
    `Document name: ${JSON.stringify(input.name)}`,
    `Chunk: ${input.chunkIndex + 1} of ${input.chunkCount}`,
    `Character range: ${input.start}-${input.end} of ${input.characterCount}`,
    "Content:",
    input.content,
  ].join("\n");
}

/**
 * Split a complete composer document into independently searchable Memo rows.
 * Tokens contain only letters and digits so the built-in FTS tokenizer and
 * external Memo implementations can both retrieve one exact piece reliably.
 */
export function buildMemoAttachmentRecords(input: {
  readonly documentToken: string;
  readonly name: string;
  readonly content: string;
}): MemoAttachmentRecords {
  if (!isMemoAttachmentDocumentToken(input.documentToken)) {
    throw new Error("Invalid Memo attachment document token.");
  }
  if (input.content.length === 0 || input.content.length > MEMO_ATTACHMENT_MAX_CHARACTERS) {
    throw new Error(
      `Memo attachment content must contain 1-${MEMO_ATTACHMENT_MAX_CHARACTERS} characters.`,
    );
  }

  const slices = splitMemoAttachmentContent(input.content);
  const chunkCount = slices.length;
  const chunks = slices.map((slice, chunkIndex) => {
    const token = memoAttachmentChunkToken(input.documentToken, chunkIndex);
    return {
      token,
      text: buildChunkText({
        documentToken: input.documentToken,
        chunkToken: token,
        name: input.name,
        content: slice.content,
        start: slice.start,
        end: slice.end,
        chunkIndex,
        chunkCount,
        characterCount: input.content.length,
      }),
    };
  });
  const manifestToken = `${input.documentToken}manifest`;
  const manifest = {
    token: manifestToken,
    text: [
      "d4research Memo attachment manifest.",
      `Manifest token: ${manifestToken}`,
      `Document token: ${input.documentToken}`,
      `Document name: ${JSON.stringify(input.name)}`,
      `Character count: ${input.content.length}`,
      `Chunk count: ${chunkCount}`,
      `First chunk token: ${chunks[0]?.token ?? ""}`,
      `Last chunk token: ${chunks[chunks.length - 1]?.token ?? ""}`,
    ].join("\n"),
  };
  return {
    documentToken: input.documentToken,
    manifestToken,
    characterCount: input.content.length,
    chunks,
    manifest,
  };
}

/**
 * Store all chunks before the manifest. The manifest is the commit marker:
 * only its exact presence makes a later retry idempotent.
 */
export const persistMemoAttachment = Effect.fn("memory.persistComposerAttachment")(
  function* (input: {
    readonly connector: LocalMemoConnector;
    readonly documentToken: string;
    readonly name: string;
    readonly content: string;
    readonly project?: string | undefined;
  }): Effect.fn.Return<
    PersistedMemoAttachment,
    MemoAttachmentPersistenceError | MemoryConnectorError
  > {
    const records = buildMemoAttachmentRecords(input);
    const existingManifest = yield* input.connector.search(records.manifestToken, 1, input.project);
    if (
      existingManifest.results.some((entry) =>
        entry.text.includes(`Manifest token: ${records.manifestToken}`),
      )
    ) {
      return {
        documentToken: input.documentToken,
        characterCount: records.characterCount,
        chunkCount: records.chunks.length,
      };
    }

    const storedChunks = yield* Effect.forEach(
      records.chunks,
      (record) =>
        input.connector.add(record.text, memoAttachmentSource(input.documentToken), input.project),
      { concurrency: 4 },
    );
    if (storedChunks.some((result) => !result.ok)) {
      return yield* new MemoAttachmentPersistenceError({
        message: "Local Memo could not store every attachment chunk.",
      });
    }
    const storedManifest = yield* input.connector.add(
      records.manifest.text,
      memoAttachmentSource(input.documentToken),
      input.project,
    );
    if (!storedManifest.ok) {
      return yield* new MemoAttachmentPersistenceError({
        message: "Local Memo could not commit the attachment manifest.",
      });
    }
    return {
      documentToken: input.documentToken,
      characterCount: records.characterCount,
      chunkCount: records.chunks.length,
    };
  },
);
