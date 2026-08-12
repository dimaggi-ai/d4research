import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { preparedEnvironmentFetchAuthorization } from "@t3tools/client-runtime/state/skills";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { sha256Hex } from "@t3tools/shared/hash";

import type { PastedContextDraft } from "./lib/pastedContext";
import { runtime } from "./lib/runtime";

export const MEMO_ATTACHMENT_PERSIST_TIMEOUT_MS = 60_000;
export const MEMO_ATTACHMENT_MANAGE_TIMEOUT_MS = 20_000;
export const MEMO_ATTACHMENT_SEND_RESERVE_CHARS = Math.floor(
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS * 0.1,
);
const MEMO_ATTACHMENT_PREVIEW_CHARACTERS = 3_800;

export interface StoredMemoAttachment {
  readonly documentToken: string;
  readonly characterCount: number;
  readonly chunkCount: number;
}

export interface MemoAttachmentPersistenceInput {
  readonly documentToken: string;
  readonly name: string;
  readonly content: string;
  readonly project: string;
}

export interface StoredMemoAttachmentSummary {
  readonly documentToken: string;
  readonly name: string | null;
  readonly project: string | null;
  readonly characterCount: number | null;
  readonly chunkCount: number | null;
  readonly storedAt: string;
  readonly incomplete: boolean;
}

export interface MemoAttachmentListResult {
  readonly backend: "builtin" | "memo-rest";
  readonly supported: boolean;
  readonly attachments: ReadonlyArray<StoredMemoAttachmentSummary>;
}

export type MemoAttachmentPersistence = (
  input: MemoAttachmentPersistenceInput,
) => Promise<StoredMemoAttachment>;

export function memoAttachmentDocumentToken(documentIdentity: string, content: string): string {
  return `memoattachment${sha256Hex(`${documentIdentity}\0${content}`)}`;
}

function memoAttachmentPreview(content: string): string {
  if (content.length <= MEMO_ATTACHMENT_PREVIEW_CHARACTERS) return content;
  const half = Math.floor(MEMO_ATTACHMENT_PREVIEW_CHARACTERS / 2);
  let headEnd = half;
  if (
    content.charCodeAt(headEnd - 1) >= 0xd800 &&
    content.charCodeAt(headEnd - 1) <= 0xdbff &&
    content.charCodeAt(headEnd) >= 0xdc00 &&
    content.charCodeAt(headEnd) <= 0xdfff
  ) {
    headEnd -= 1;
  }
  let tailStart = content.length - half;
  if (
    content.charCodeAt(tailStart - 1) >= 0xd800 &&
    content.charCodeAt(tailStart - 1) <= 0xdbff &&
    content.charCodeAt(tailStart) >= 0xdc00 &&
    content.charCodeAt(tailStart) <= 0xdfff
  ) {
    tailStart += 1;
  }
  return [
    content.slice(0, headEnd),
    "… [preview shortened; full document is available in Memo chunks] …",
    content.slice(tailStart),
  ].join("\n");
}

export function buildMemoAttachmentReference(input: {
  readonly name: string;
  readonly project: string;
  readonly content: string;
  readonly stored: StoredMemoAttachment;
}): string {
  const firstChunkToken = `${input.stored.documentToken}chunk0001`;
  const lastChunkToken = `${input.stored.documentToken}chunk${String(
    input.stored.chunkCount,
  ).padStart(4, "0")}`;
  return [
    "<memo_document>",
    "The complete attachment is preserved in local Memo; the preview below is not authoritative.",
    `Document name: ${JSON.stringify(input.name)}`,
    `Project: ${JSON.stringify(input.project)}`,
    `Document token: ${input.stored.documentToken}`,
    `Characters: ${input.stored.characterCount}`,
    `Chunks: ${input.stored.chunkCount}`,
    "When memory_search is available in this provider session, retrieve one exact piece at a time:",
    'connector="local"',
    `project=${JSON.stringify(input.project)}`,
    `query="${firstChunkToken}" (then increment through "${lastChunkToken}")`,
    "limit=1",
    "Use as many chunk calls as needed for the user's task.",
    "If an exact chunk query returns no results, the document was removed from Memo. Say so instead of inferring missing content from the preview.",
    "If memory_search is unavailable, use only this preview and tell the user that the full local copy requires a capable same-thread handoff.",
    "<preview>",
    memoAttachmentPreview(input.content),
    "</preview>",
    "</memo_document>",
  ].join("\n");
}

export function pastedContextsNeedMemo(input: {
  readonly contexts: ReadonlyArray<PastedContextDraft>;
  readonly renderedTextLength: number;
  readonly maxChars: number;
}): boolean {
  return (
    input.contexts.length > 0 &&
    (input.contexts.some(
      (context) => context.sourceContent !== undefined || context.contentTruncated === true,
    ) ||
      input.renderedTextLength > input.maxChars)
  );
}

/**
 * Persist complete documents before replacing them with compact send-only
 * references. A persisted preview that has lost its in-memory source is
 * rejected explicitly instead of silently sending incomplete text.
 */
export async function replacePastedContextsWithMemoReferences(input: {
  readonly contexts: ReadonlyArray<PastedContextDraft>;
  readonly project: string;
  readonly persist: MemoAttachmentPersistence;
}): Promise<ReadonlyArray<PastedContextDraft>> {
  const pendingDocuments = new Map<string, Promise<StoredMemoAttachment>>();
  return Promise.all(
    input.contexts.map(async (context) => {
      if (context.contentTruncated && context.sourceContent === undefined) {
        throw new Error(
          `Remove the stale ${JSON.stringify(context.name)} attachment, then reattach it so its complete text can be saved to Memo.`,
        );
      }
      const content = context.sourceContent ?? context.content;
      const documentToken = memoAttachmentDocumentToken(
        `${input.project}\0${context.name}`,
        content,
      );
      let storedDocument = pendingDocuments.get(documentToken);
      if (storedDocument === undefined) {
        storedDocument = input.persist({
          documentToken,
          name: context.name,
          content,
          project: input.project,
        });
        pendingDocuments.set(documentToken, storedDocument);
      }
      const stored = await storedDocument;
      return {
        id: context.id,
        name: context.name,
        fromFile: context.fromFile,
        content: buildMemoAttachmentReference({
          name: context.name,
          project: input.project,
          content,
          stored,
        }),
      };
    }),
  );
}

/**
 * Send-path boundary for Memo preparation. The pending callback is always
 * released, including persistence failures, so a user can remove or retry an
 * attachment without reloading the chat page.
 */
export async function prepareMemoPastedContextsForSend(input: {
  readonly contexts: ReadonlyArray<PastedContextDraft>;
  readonly project: string;
  readonly persist: MemoAttachmentPersistence;
  readonly onPreparingChange: (preparing: boolean) => void;
}): Promise<ReadonlyArray<PastedContextDraft>> {
  input.onPreparingChange(true);
  try {
    return await replacePastedContextsWithMemoReferences(input);
  } finally {
    input.onPreparingChange(false);
  }
}

export function makeMemoAttachmentPersistence(
  preparedConnection: PreparedConnection,
): MemoAttachmentPersistence {
  return async (body) => {
    const endpoint = new URL("/api/memory/attachment", preparedConnection.httpBaseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMO_ATTACHMENT_PERSIST_TIMEOUT_MS);
    try {
      const auth = await runtime.runPromise(
        preparedEnvironmentFetchAuthorization(preparedConnection, "POST", endpoint),
      );
      const response = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        ...(auth.credentials ? { credentials: auth.credentials } : {}),
        headers: { "content-type": "application/json", ...auth.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: unknown;
        message?: unknown;
        documentToken?: unknown;
        characterCount?: unknown;
        chunkCount?: unknown;
      } | null;
      if (
        response.ok &&
        result?.ok === true &&
        result.documentToken === body.documentToken &&
        typeof result.characterCount === "number" &&
        Number.isSafeInteger(result.characterCount) &&
        result.characterCount === body.content.length &&
        typeof result.chunkCount === "number" &&
        Number.isSafeInteger(result.chunkCount) &&
        result.chunkCount > 0
      ) {
        return {
          documentToken: result.documentToken,
          characterCount: result.characterCount,
          chunkCount: result.chunkCount,
        };
      }
      throw new Error(
        typeof result?.message === "string"
          ? result.message
          : "Local Memo could not store the complete attachment.",
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Saving the complete attachment to local Memo timed out.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function memoAttachmentManagementRequest(
  preparedConnection: PreparedConnection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const endpoint = new URL(path, preparedConnection.httpBaseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMO_ATTACHMENT_MANAGE_TIMEOUT_MS);
  try {
    const auth = await runtime.runPromise(
      preparedEnvironmentFetchAuthorization(preparedConnection, method, endpoint),
    );
    const response = await fetch(endpoint, {
      method,
      cache: "no-store",
      ...(auth.credentials ? { credentials: auth.credentials } : {}),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...auth.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => null)) as {
      readonly message?: unknown;
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof result?.message === "string" ? result.message : "Local Memo request failed.",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The Local Memo request timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isStoredMemoAttachmentSummary(value: unknown): value is StoredMemoAttachmentSummary {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.documentToken === "string" &&
    (typeof entry.name === "string" || entry.name === null) &&
    (typeof entry.project === "string" || entry.project === null) &&
    (typeof entry.characterCount === "number" || entry.characterCount === null) &&
    (typeof entry.chunkCount === "number" || entry.chunkCount === null) &&
    typeof entry.storedAt === "string" &&
    typeof entry.incomplete === "boolean"
  );
}

export async function listStoredMemoAttachments(
  preparedConnection: PreparedConnection,
): Promise<MemoAttachmentListResult> {
  const result = (await memoAttachmentManagementRequest(
    preparedConnection,
    "GET",
    "/api/memory/attachments",
  )) as {
    readonly ok?: unknown;
    readonly backend?: unknown;
    readonly supported?: unknown;
    readonly attachments?: unknown;
  } | null;
  if (
    result?.ok !== true ||
    (result.backend !== "builtin" && result.backend !== "memo-rest") ||
    typeof result.supported !== "boolean" ||
    !Array.isArray(result.attachments) ||
    !result.attachments.every(isStoredMemoAttachmentSummary)
  ) {
    throw new Error("Local Memo returned an invalid attachment list.");
  }
  return {
    backend: result.backend,
    supported: result.supported,
    attachments: result.attachments,
  };
}

export async function deleteStoredMemoAttachment(
  preparedConnection: PreparedConnection,
  documentToken: string,
): Promise<number> {
  const result = (await memoAttachmentManagementRequest(
    preparedConnection,
    "POST",
    "/api/memory/attachment/delete",
    { documentToken },
  )) as { readonly ok?: unknown; readonly deleted?: unknown } | null;
  if (
    result?.ok !== true ||
    typeof result.deleted !== "number" ||
    !Number.isSafeInteger(result.deleted) ||
    result.deleted < 0
  ) {
    throw new Error("Local Memo returned an invalid deletion result.");
  }
  return result.deleted;
}
