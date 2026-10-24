import { ProviderDriverKind } from "@d4research/contracts";
import { defineProviderClient } from "@d4research/provider-core/client";
import { DeepSeekSettings } from "./settings.ts";
export const deepSeekClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("deepseek"),
  label: "DeepSeek (local)",
  badgeLabel: "Text only",
  hasDefaultInstance: false,
  settingsSchema: DeepSeekSettings,
});
