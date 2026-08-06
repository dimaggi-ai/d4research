import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";

const DEFAULT_COMPRESSION_PROMPT = `Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
Output only the compressed summary, no preamble.`;

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const LOCAL_COMPRESSION_TIMEOUT_MILLIS = 60_000;

/**
 * Deterministic, model-free fallback: keeps the head (task statement) and the
 * most recent tail of the transcript within the character budget. Used whenever
 * model-based compression is unavailable or fails — handoff must never block.
 */
export function truncateHandoffTranscript(transcript: string, maxCharacters: number): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= maxCharacters) return trimmed;
  const marker = "\n\n[... middle of conversation omitted ...]\n\n";
  const budget = Math.max(0, maxCharacters - marker.length);
  const headLength = Math.floor(budget * 0.3);
  const tailLength = budget - headLength;
  return `${trimmed.slice(0, headLength)}${marker}${trimmed.slice(trimmed.length - tailLength)}`;
}

export class LocalHandoffCompressionError extends Data.TaggedError("LocalHandoffCompressionError")<{
  readonly detail: string;
}> {}

export interface CompressHandoffContextLocalInput {
  readonly transcript: string;
  readonly model: string;
  readonly maxInputCharacters: number;
  readonly maxOutputCharacters: number;
  readonly customPrompt: string;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
}

/**
 * Compresses a handoff transcript with a local Ollama model. Total by design:
 * any failure (daemon down, model missing, timeout, empty reply) falls back to
 * plain structured truncation instead of erroring.
 */
export const compressHandoffContextLocal = Effect.fn("compressHandoffContextLocal")(function* (
  input: CompressHandoffContextLocalInput,
) {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const baseUrl = (input.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const transcript = input.transcript.slice(0, input.maxInputCharacters);
  const systemPrompt = input.customPrompt.trim() || DEFAULT_COMPRESSION_PROMPT;
  // ~4 chars/token heuristic for prompt + transcript + reply, rounded up to 1k,
  // clamped so a large maxInputCharacters cannot blow up local VRAM use.
  const estimatedTokens =
    Math.ceil((input.maxInputCharacters + input.maxOutputCharacters) / 4) + 512;
  const numCtx = Math.min(16_384, Math.max(2_048, Math.ceil(estimatedTokens / 1_024) * 1_024));

  const compressed = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Ollama's /api/chat body is a fixed vendor shape, not a domain schema.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: JSON.stringify({
          model: input.model,
          stream: false,
          keep_alive: "2m",
          options: { num_ctx: numCtx },
          messages: [
            {
              role: "system",
              content: `${systemPrompt}\nMaximum length: ${input.maxOutputCharacters} characters.`,
            },
            { role: "user", content: `--- TRANSCRIPT ---\n${transcript}` },
          ],
        }),
      });
      if (!response.ok) {
        throw new LocalHandoffCompressionError({
          detail: `Local compression model responded with status ${response.status}.`,
        });
      }
      const payload = (await response.json()) as { message?: { content?: unknown } } | null;
      const content = payload?.message?.content;
      return typeof content === "string" ? content.trim() : "";
    },
    catch: (cause) =>
      cause instanceof LocalHandoffCompressionError
        ? cause
        : new LocalHandoffCompressionError({ detail: String(cause) }),
  }).pipe(
    Effect.timeout(input.timeoutMillis ?? LOCAL_COMPRESSION_TIMEOUT_MILLIS),
    Effect.orElseSucceed(() => ""),
  );

  if (!compressed) return truncateHandoffTranscript(transcript, input.maxOutputCharacters);
  return compressed.length > input.maxOutputCharacters
    ? compressed.slice(0, input.maxOutputCharacters)
    : compressed;
});

export interface CompressHandoffContextInput {
  readonly transcript: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly maxOutputCharacters: number;
  readonly customPrompt: string;
  readonly cwd: string;
}

export class HandoffCompressionError extends Data.TaggedError("HandoffCompressionError")<{
  readonly detail: string;
}> {}

export const compressHandoffContext = Effect.fn("compressHandoffContext")(function* (
  input: CompressHandoffContextInput,
) {
  const registry = yield* ProviderAdapterRegistry;
  const adapter = yield* registry.getByInstance(input.instanceId).pipe(
    Effect.mapError(
      (cause) =>
        new HandoffCompressionError({
          detail: `Provider '${input.instanceId}' unavailable: ${cause.message}`,
        }),
    ),
  );

  const systemPrompt = input.customPrompt.trim() || DEFAULT_COMPRESSION_PROMPT;
  const turnInput = [
    systemPrompt,
    `Maximum length: ${input.maxOutputCharacters} characters.`,
    "",
    "--- TRANSCRIPT ---",
    input.transcript,
  ].join("\n");

  const threadId = ThreadId.make(`handoff-compress-${yield* Clock.currentTimeMillis}`);

  yield* adapter
    .startSession({
      threadId,
      provider: adapter.provider,
      cwd: input.cwd,
      runtimeMode: "approval-required",
      modelSelection: { instanceId: input.instanceId, model: input.model },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new HandoffCompressionError({
            detail: `Failed to start compression session: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
    );

  const compressed = yield* adapter
    .sendTurn({
      threadId,
      input: turnInput,
      attachments: [],
      modelSelection: { instanceId: input.instanceId, model: input.model },
    })
    .pipe(
      Effect.flatMap(() => adapter.readThread(threadId)),
      Effect.map((thread) => {
        const lastTurn = thread.turns[thread.turns.length - 1];
        if (!lastTurn) return "";
        return lastTurn.items
          .map((item) => {
            if (typeof item === "string") return item;
            if (typeof item === "object" && item !== null && "text" in item) {
              return String((item as { text: unknown }).text);
            }
            return "";
          })
          .join("")
          .trim();
      }),
      Effect.mapError(
        (cause) =>
          new HandoffCompressionError({
            detail: `Compression turn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
      Effect.ensuring(adapter.stopSession(threadId).pipe(Effect.ignore)),
    );

  if (!compressed) {
    return yield* new HandoffCompressionError({
      detail: "Empty response from compression provider.",
    });
  }

  return compressed.length > input.maxOutputCharacters
    ? compressed.slice(0, input.maxOutputCharacters)
    : compressed;
});
