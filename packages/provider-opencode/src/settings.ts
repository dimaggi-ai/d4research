/**
 * Shared by the server driver and the client settings form, so it holds only
 * browser-safe schema code.
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const OpenCodeModelLimit = Schema.Int.check(Schema.isGreaterThan(0));
export const OpenCodeConfig = Schema.Struct({
  provider: Schema.Record(
    TrimmedNonEmptyString,
    Schema.Struct({
      npm: Schema.Literal("@ai-sdk/openai-compatible"),
      name: Schema.optionalKey(TrimmedNonEmptyString),
      options: Schema.Struct({ baseURL: TrimmedNonEmptyString }),
      models: Schema.Record(
        TrimmedNonEmptyString,
        Schema.Struct({
          name: Schema.optionalKey(TrimmedNonEmptyString),
          limit: Schema.Struct({ context: OpenCodeModelLimit, output: OpenCodeModelLimit }),
        }),
      ),
    }),
  ),
});

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    config: OpenCodeConfig.pipe(
      Schema.withDecodingDefault(Effect.succeed({ provider: {} })),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;
