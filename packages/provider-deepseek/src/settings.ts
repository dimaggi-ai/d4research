import { makeProviderSettingsSchema } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DEFAULT_DEEPSEEK_ENDPOINT = "http://127.0.0.1:8094/v1";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4.1-flash-ist-das-1.75bpw";

export function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export const DeepSeekSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    smartRouting: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ title: "Smart routing" }),
    ),
    taskMode: Schema.Literals(["text", "tools"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("text" as const)),
      Schema.annotateKey({ title: "Task mode" }),
    ),
    fallbackInstanceId: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ title: "Fallback provider instance" }),
    ),
    fallbackModel: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ title: "Fallback model" }),
    ),
    endpoint: Schema.String.check(Schema.makeFilter(isLoopbackEndpoint)).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_DEEPSEEK_ENDPOINT)),
      Schema.annotateKey({
        title: "Local endpoint",
        description: "HTTP endpoint on 127.0.0.1 or ::1. Text only; tools and MCP are unavailable.",
      }),
    ),
    model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_DEEPSEEK_MODEL)),
      Schema.annotateKey({ title: "Model" }),
    ),
    contextWindowTokens: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1024),
      Schema.isLessThanOrEqualTo(1048576),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed(32768)),
      Schema.annotateKey({ title: "Context window tokens" }),
    ),
    requestTimeoutMs: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1000),
      Schema.isLessThanOrEqualTo(7_200_000),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed(120000)),
      Schema.annotateKey({ title: "Request timeout (ms)" }),
    ),
  },
  {
    order: [
      "endpoint",
      "model",
      "contextWindowTokens",
      "requestTimeoutMs",
      "smartRouting",
      "taskMode",
      "fallbackInstanceId",
      "fallbackModel",
    ],
  },
);
export type DeepSeekSettings = typeof DeepSeekSettings.Type;
