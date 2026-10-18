/**
 * Shared by the server driver and the client settings form, so it holds only browser-safe schema
 * code.
 */
import {
  CustomModelSetting,
  MuseSettings as LegacyMuseSettings,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MuseSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("muse").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the Muse Code binary on this environment. Sign in with muse login on that host.",
        providerSettingsForm: { placeholder: "muse", clearWhenEmpty: "omit" },
      }),
    ),
    approvalMode: LegacyMuseSettings.fields.approvalMode,
    // Omission follows the thread runtime mode; false explicitly keeps the sandbox.
    disableSandbox: Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ title: "Disable sandbox", providerSettingsForm: { control: "switch" } }),
    ),
    sandboxNetwork: LegacyMuseSettings.fields.sandboxNetwork,
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath", "approvalMode", "disableSandbox", "sandboxNetwork"] },
);
export type MuseSettings = typeof MuseSettings.Type;
