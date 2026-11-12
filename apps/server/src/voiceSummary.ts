import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Spoken summaries for voice conversations. The local Gemma 4 server answers
 * OpenAI-compatible completions; with thinking left on, its reasoning spends
 * the whole token budget and the reply comes back empty, which is why the
 * voice gateway's own /voice/summarize endpoint cannot be used for this.
 */
const DEFAULT_VOICE_SUMMARY_BASE_URL = "http://127.0.0.1:19137";
const DEFAULT_VOICE_SUMMARY_MODEL = "gemma4-12b";
const VOICE_SUMMARY_TIMEOUT_MILLIS = 15_000;
export const VOICE_SUMMARY_MAX_INPUT_CHARACTERS = 8_000;
const VOICE_SUMMARY_MAX_OUTPUT_CHARACTERS = 500;

const VOICE_SUMMARY_PROMPT =
  "You are Nia, a voice assistant. The text is your own written reply, which the user will read on screen. " +
  "Say aloud, in one to three short plain sentences, what the reply concluded or did and what the user should look at. " +
  "Speak in the first person. Never read code, commands, file paths, URLs, or table cells aloud; mention them by kind, " +
  "for example 'the diff is on screen'. No markdown, no lists, no preamble.";

class VoiceSummaryError extends Schema.TaggedError<VoiceSummaryError>()("VoiceSummaryError", {
  detail: Schema.String,
}) {}

const isVoiceSummaryError = Schema.is(VoiceSummaryError);
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

interface CompletionPayload {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }>;
}

function spokenText(raw: string): string {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= VOICE_SUMMARY_MAX_OUTPUT_CHARACTERS) return text;
  const clipped = text.slice(0, VOICE_SUMMARY_MAX_OUTPUT_CHARACTERS);
  const sentenceEnd = clipped.search(/[.!?][^.!?]*$/);
  return sentenceEnd > 0 ? clipped.slice(0, sentenceEnd + 1) : clipped;
}

export const summarizeForSpeech = Effect.fn("summarizeForSpeech")(function* (input: {
  readonly text: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
}) {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const url = `${(input.baseUrl ?? DEFAULT_VOICE_SUMMARY_BASE_URL).replace(/\/$/, "")}/v1/chat/completions`;
  const body = yield* encodeJson({
    model: input.model ?? DEFAULT_VOICE_SUMMARY_MODEL,
    max_tokens: 220,
    temperature: 0.2,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: VOICE_SUMMARY_PROMPT },
      { role: "user", content: input.text.slice(0, VOICE_SUMMARY_MAX_INPUT_CHARACTERS) },
    ],
  }).pipe(Effect.mapError((cause) => new VoiceSummaryError({ detail: String(cause) })));
  const payload = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchFn(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok) {
        throw new VoiceSummaryError({ detail: `Summarizer responded with ${response.status}.` });
      }
      return (await response.json()) as CompletionPayload | null;
    },
    catch: (cause) =>
      isVoiceSummaryError(cause) ? cause : new VoiceSummaryError({ detail: String(cause) }),
  }).pipe(
    Effect.timeout(input.timeoutMillis ?? VOICE_SUMMARY_TIMEOUT_MILLIS),
    Effect.mapError((cause) =>
      isVoiceSummaryError(cause) ? cause : new VoiceSummaryError({ detail: String(cause) }),
    ),
  );
  const content = payload?.choices?.[0]?.message?.content;
  const summary = typeof content === "string" ? spokenText(content) : "";
  if (!summary) return yield* new VoiceSummaryError({ detail: "Summarizer returned no text." });
  return summary;
});
