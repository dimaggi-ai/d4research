import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

/**
 * Pasted / dropped text carried as an attachment instead of raw prompt body.
 *
 * A large paste (a log, a transcript, a document) and a dropped text file are
 * the same thing to the model but very different to read: inline they bury the
 * actual instruction under thousands of lines. Claude and ChatGPT collapse
 * both into an attachment chip; this does the same without a new control —
 * the composer converts on paste/drop, and the transcript renders the chip.
 *
 * The content rides inside the message text in a trailing `<pasted_context>`
 * block, mirroring `elementContext`/`terminalContext`. That keeps every
 * provider working unchanged (they see the text) while the UI can strip and
 * render it as a bubble.
 */

/** Pastes at least this long become an attachment instead of inline text. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 2_000;

/**
 * Leave one quarter of the provider wire budget for the user's instruction,
 * metadata, and other composer contexts. The final composed message is still
 * checked because several individually valid attachments can exceed the cap.
 */
export const PASTED_CONTEXT_MAX_CHARS = Math.floor(PROVIDER_SEND_TURN_MAX_INPUT_CHARS * 0.75);
/** Matches the image attachment affordance and bounds concurrent file reads. */
export const PASTED_CONTEXT_MAX_COUNT = 8;

export function shouldConvertPasteToContext(input: {
  readonly textLength: number;
  readonly existingContextCount: number;
  readonly pendingContextCount: number;
}): boolean {
  return (
    input.textLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD &&
    input.existingContextCount + input.pendingContextCount < PASTED_CONTEXT_MAX_COUNT
  );
}

const TRAILING_PASTED_CONTEXT_BLOCK_PATTERN =
  /\n*<pasted_context(?: version="(2)")?>\n([\s\S]*?)\n<\/pasted_context>\s*$/;

export interface PastedContextDraft {
  /** Stable composer-side id for keyed rendering and removal. */
  id: string;
  /** Display name: the dropped file's name, or a generated paste label. */
  name: string;
  /** Full text content. */
  content: string;
  /** True when it came from a file drop rather than a paste. */
  fromFile: boolean;
}

export interface ParsedPastedContextEntry {
  name: string;
  body: string;
  lineCount: number;
  charCount: number;
}

export interface ExtractedPastedContexts {
  promptText: string;
  contextCount: number;
  contexts: ParsedPastedContextEntry[];
}

const PASTED_CONTEXT_ID_PREFIX = "paste_";
let nextPastedContextSequence = 0;

export function newPastedContextId(): string {
  nextPastedContextSequence += 1;
  const randomBytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  const entropy = randomBytes
    ? Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    : `${Date.now().toString(36)}_${nextPastedContextSequence.toString(36)}`;
  return `${PASTED_CONTEXT_ID_PREFIX}${entropy}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

/** A name is only meaningful per attachment; keep it short and filesystem-ish. */
function sanitizeName(name: string): string {
  const trimmed = name.trim().replace(/[\n\r]+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed || "pasted text";
}

/**
 * Builds a draft entry from raw text. Content longer than the cap is truncated
 * with an explicit marker rather than silently trimmed, so the model is never
 * told it has content it does not.
 */
export function makePastedContext(input: {
  readonly name: string;
  readonly content: string;
  readonly fromFile: boolean;
}): PastedContextDraft {
  const normalized = normalizeText(input.content);
  const content =
    normalized.length > PASTED_CONTEXT_MAX_CHARS
      ? `${normalized.slice(0, PASTED_CONTEXT_MAX_CHARS)}\n… [truncated: ${
          normalized.length - PASTED_CONTEXT_MAX_CHARS
        } more characters]`
      : normalized;
  return {
    id: newPastedContextId(),
    name: sanitizeName(input.name),
    content,
    fromFile: input.fromFile,
  };
}

/** Label for a paste with no filename: "Pasted text (312 lines)". */
export function pastedTextLabel(content: string): string {
  return `Pasted text (${countLines(normalizeText(content))} lines)`;
}

export interface PastedContextFileReadResult {
  readonly contexts: ReadonlyArray<PastedContextDraft>;
  readonly rejectedNames: ReadonlyArray<string>;
  readonly skippedCount: number;
}

/** Reads a bounded batch independently so one unreadable file cannot reject the whole drop. */
export async function readPastedContextFiles(
  files: ReadonlyArray<{ readonly name: string; text: () => Promise<string> }>,
  availableSlots = PASTED_CONTEXT_MAX_COUNT,
): Promise<PastedContextFileReadResult> {
  const capacity = Math.max(0, Math.min(PASTED_CONTEXT_MAX_COUNT, Math.floor(availableSlots)));
  const selected = files.slice(0, capacity);
  const settled = await Promise.allSettled(
    selected.map(async (file) =>
      makePastedContext({ name: file.name, content: await file.text(), fromFile: true }),
    ),
  );
  const contexts: PastedContextDraft[] = [];
  const rejectedNames: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value.content.length > 0) {
      contexts.push(result.value);
      return;
    }
    rejectedNames.push(selected[index]?.name || "text file");
  });
  return { contexts, rejectedNames, skippedCount: Math.max(0, files.length - selected.length) };
}

function buildPastedContextBlock(contexts: ReadonlyArray<PastedContextDraft>): string {
  if (contexts.length === 0) return "";
  const entries = contexts
    .map(
      (context) =>
        `${JSON.stringify({ name: context.name, contentLength: context.content.length })}\n${context.content}`,
    )
    .join("\n");
  return `<pasted_context version="2">\n${entries}\n</pasted_context>`;
}

/**
 * Appends the attachment block at send time. Mirrors
 * `appendElementContextsToPrompt`; the provider simply receives the text.
 */
export function appendPastedContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<PastedContextDraft>,
): string {
  const block = buildPastedContextBlock(contexts);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

/**
 * Mirror image of the append, for transcript display: strips a trailing
 * `<pasted_context>` block so the bubble can render the prompt body and the
 * attachment chips separately.
 */
export function extractTrailingPastedContexts(prompt: string): ExtractedPastedContexts {
  const match = TRAILING_PASTED_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, contextCount: 0, contexts: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const contexts =
    match[1] === "2"
      ? parseLengthPrefixedPastedContextEntries(match[2] ?? "")
      : parseLegacyPastedContextEntries(match[2] ?? "");
  if (contexts === null) {
    return { promptText: prompt, contextCount: 0, contexts: [] };
  }
  return { promptText, contextCount: contexts.length, contexts };
}

function parsedEntry(name: string, body: string): ParsedPastedContextEntry {
  return {
    name,
    body,
    lineCount: countLines(body),
    charCount: body.length,
  };
}

function parseLengthPrefixedPastedContextEntries(block: string): ParsedPastedContextEntry[] | null {
  const entries: ParsedPastedContextEntry[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    const headerEnd = block.indexOf("\n", cursor);
    if (headerEnd < 0) return null;
    let header: unknown;
    try {
      header = JSON.parse(block.slice(cursor, headerEnd));
    } catch {
      return null;
    }
    if (
      typeof header !== "object" ||
      header === null ||
      !("name" in header) ||
      typeof header.name !== "string" ||
      !("contentLength" in header) ||
      !Number.isSafeInteger(header.contentLength) ||
      (header.contentLength as number) < 0
    ) {
      return null;
    }
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + (header.contentLength as number);
    if (bodyEnd > block.length) return null;
    entries.push(parsedEntry(header.name, block.slice(bodyStart, bodyEnd)));
    cursor = bodyEnd;
    if (cursor === block.length) break;
    if (block[cursor] !== "\n") return null;
    cursor += 1;
  }
  return entries;
}

/** Reads messages sent before the length-prefixed v2 format shipped. */
function parseLegacyPastedContextEntries(block: string): ParsedPastedContextEntry[] {
  const entries: Array<{ name: string; bodyLines: string[] }> = [];
  let current: { name: string; bodyLines: string[] } | null = null;
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      if (current) entries.push(current);
      current = { name: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) entries.push(current);
  return entries.map((entry) => parsedEntry(entry.name, entry.bodyLines.join("\n").trimEnd()));
}

/** True for files we can read as text rather than treat as an image. */
export function isTextLikeFile(file: { readonly type: string; readonly name: string }): boolean {
  if (file.type.startsWith("image/")) return false;
  if (file.type.startsWith("text/")) return true;
  if (
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/x-yaml" ||
    file.type === "application/yaml"
  ) {
    return true;
  }
  // Extension fallback: many editors/OSes report an empty type for source and
  // config files, which are exactly what gets dropped into a coding agent.
  return /\.(md|markdown|txt|log|json|ya?ml|toml|ini|csv|tsv|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|sh|bash|zsh|fish|sql|html|css|scss|diff|patch|env|conf|cfg)$/i.test(
    file.name,
  );
}
