import {
  AgySettings,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  JunieSettings,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@d4research/contracts";
import { acpRegistryClient } from "@d4research/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@d4research/provider-core/client";
import { modelShortName } from "@d4research/provider-core/modelShortName";
import { cursorClient } from "@d4research/provider-cursor/client";
import { deepSeekClient } from "@d4research/provider-deepseek/client";
import { fxClient } from "@d4research/provider-fx/client";
import { grokClient } from "@d4research/provider-grok/client";
import { museClient } from "@d4research/provider-muse/client";
import { openCodeClient } from "@d4research/provider-opencode/client";
import { piClient } from "@d4research/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  {
    driverKind: ProviderDriverKind.make("agy"),
    label: "Agy",
    badgeLabel: "Early Access",
    settingsSchema: AgySettings,
  },
  {
    driverKind: ProviderDriverKind.make("junie"),
    label: "Junie",
    badgeLabel: "Early Access",
    settingsSchema: JunieSettings,
  },
  deepSeekClient,
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
