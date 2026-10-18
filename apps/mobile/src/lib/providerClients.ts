import { isProviderDriverKind } from "@d4research/contracts";
import { acpRegistryClient } from "@d4research/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@d4research/provider-core/client";
import { cursorClient } from "@d4research/provider-cursor/client";
import { grokClient } from "@d4research/provider-grok/client";
import { museClient } from "@d4research/provider-muse/client";
import { openCodeClient } from "@d4research/provider-opencode/client";
import { piClient } from "@d4research/provider-pi/client";

const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
