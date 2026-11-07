import { useMemo } from "react";

import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@d4research/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind } from "@d4research/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
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
  providers: ReadonlyArray<ThreadListProvider> | undefined,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  if (providers === undefined) return null;
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
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
      { ...entry, enabled: snapshot.enabled },
      providers.map((provider) => ({ driverKind: provider.driver, enabled: provider.enabled })),
    ),
  };
}

// Cache per provider-list generation so memoized rows keep stable instance props
// until their provider instance changes.
export function createThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cacheKey = `${thread.environmentId}|${instanceId ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function useThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(
    () => createThreadRowProviderInstanceResolver(providersByEnvironmentId),
    [providersByEnvironmentId],
  );
}
