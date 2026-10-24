import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { collectUint8StreamText } from "@d4research/provider-core/server/collectStreamText";
import { isLoopbackEndpoint, type DeepSeekSettings } from "../settings.ts";

export class DeepSeekRequestError extends Schema.TaggedError<DeepSeekRequestError>()(
  "DeepSeekRequestError",
  {
    category: Schema.Literals([
      "configuration",
      "transport",
      "timeout",
      "protocol",
      "tools",
      "context",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "The local DeepSeek request failed.";
  }
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.NullOr(Schema.String),
      message: Schema.Struct({
        content: Schema.NullOr(Schema.String),
        tool_calls: Schema.optional(Schema.Unknown),
        function_call: Schema.optional(Schema.Unknown),
      }),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      completion_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      total_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});

const decodeCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(Completion));

export const requestCompletion = (
  client: HttpClient.HttpClient,
  config: DeepSeekSettings,
  messages: ReadonlyArray<ChatMessage>,
) =>
  Effect.gen(function* () {
    if (!isLoopbackEndpoint(config.endpoint))
      return yield* new DeepSeekRequestError({ category: "configuration" });
    // A UTF-8 byte bound is conservative for tokenization and never silently drops history.
    const promptBytes = messages.reduce(
      (sum, message) => sum + new TextEncoder().encode(message.content).length + 32,
      0,
    );
    if (promptBytes > config.contextWindowTokens - 512)
      return yield* new DeepSeekRequestError({ category: "context" });
    const request = yield* HttpClientRequest.post(
      `${config.endpoint.replace(/\/$/, "")}/chat/completions`,
    ).pipe(
      HttpClientRequest.bodyJson({
        model: config.model,
        messages,
        stream: false,
        max_tokens: Math.min(4096, config.contextWindowTokens - promptBytes),
      }),
      Effect.mapError((cause) => new DeepSeekRequestError({ category: "configuration", cause })),
    );
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.mapError((cause) => new DeepSeekRequestError({ category: "transport", cause })),
    );
    if (response.status !== 200) return yield* new DeepSeekRequestError({ category: "transport" });
    const body = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: 2 * 1024 * 1024,
    }).pipe(Effect.mapError((cause) => new DeepSeekRequestError({ category: "transport", cause })));
    if (body.truncated || body.invalidUtf8)
      return yield* new DeepSeekRequestError({ category: "protocol" });
    const completion = yield* decodeCompletion(body.text).pipe(
      Effect.mapError((cause) => new DeepSeekRequestError({ category: "protocol", cause })),
    );
    const choice = completion.choices[0];
    if (!choice) return yield* new DeepSeekRequestError({ category: "protocol" });
    if (
      choice.message.tool_calls !== undefined ||
      choice.message.function_call !== undefined ||
      choice.finish_reason === "tool_calls" ||
      choice.finish_reason === "function_call"
    ) {
      return yield* new DeepSeekRequestError({ category: "tools" });
    }
    if (
      choice.finish_reason !== "stop" ||
      typeof choice.message.content !== "string" ||
      choice.message.content.trim().length === 0
    ) {
      return yield* new DeepSeekRequestError({ category: "protocol" });
    }
    return { text: choice.message.content, usage: completion.usage };
  }).pipe(
    Effect.timeout(config.requestTimeoutMs),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(new DeepSeekRequestError({ category: "timeout", cause })),
    }),
  );
