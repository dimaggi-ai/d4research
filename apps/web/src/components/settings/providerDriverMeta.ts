import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@d4research/contracts";
import { acpRegistryClient } from "@d4research/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@d4research/provider-core/client";
import { cursorClient } from "@d4research/provider-cursor/client";
import { grokClient } from "@d4research/provider-grok/client";
import { museClient } from "@d4research/provider-muse/client";
import { openCodeClient } from "@d4research/provider-opencode/client";
import { piClient } from "@d4research/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
