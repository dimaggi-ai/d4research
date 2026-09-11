import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@d4research/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind, ServerConfig } from "@d4research/contracts";

/** What a thread row needs to draw the provider glyph and its account badge. */
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
}

/**
 * Resolve the provider instance a thread runs on, scoped to the thread's own
 * environment: default instance ids are the driver slug, so the same id
 * names a different account on every server.
 */
export function resolveThreadProviderInstance(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  const providers = serverConfigs.get(thread.environmentId)?.providers ?? [];
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
  };
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      entry,
      providers.map((provider) => ({ driverKind: provider.driver })),
    ),
  };
}
