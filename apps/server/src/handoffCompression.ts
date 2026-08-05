import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";

const DEFAULT_COMPRESSION_PROMPT = `Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
Output only the compressed summary, no preamble.`;

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
  const adapter = yield* registry
    .getByInstance(input.instanceId)
    .pipe(
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

  const threadId = ThreadId.make(`handoff-compress-${Date.now()}`);

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
