import {
  canStartProviderTurn,
  supportsD4AgentDriver,
  type ServerProvider,
} from "@d4research/contracts";

// This is a snapshot of configured runtimes, not an inventory of paid subscriptions.
// Keep account identifiers, credential fingerprints and runtime paths out of Nia's context.
export function providerDecisionContext(providers: ReadonlyArray<ServerProvider>, now: number) {
  return providers.map((provider) => {
    const limits = provider.usageLimits;
    const windows = limits?.windows ?? [];
    // A reset that has passed invalidates the old balance; it does not prove replenishment.
    const resetPassed = windows.some(
      (window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now,
    );
    const quotaState =
      !limits || limits.unavailable || windows.length === 0
        ? "unknown"
        : windows.some(
              (window) =>
                window.usedPercent >= 100 &&
                (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
            )
          ? "reported-exhausted"
          : resetPassed
            ? "unknown"
            : "reported-remaining";
    return {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? null,
      configured: true,
      enabled: provider.enabled,
      installed: provider.installed,
      authentication: provider.auth.status,
      status: provider.status,
      checkedAt: provider.checkedAt,
      available: canStartProviderTurn(provider),
      // Raw diagnostics can contain endpoint credentials and private paths.
      readiness: provider.readiness
        ? {
            installation: provider.readiness.installation,
            authentication: provider.readiness.authentication,
            reachability: provider.readiness.reachability,
            modelCatalog: provider.readiness.modelCatalog,
            canStart: provider.readiness.canStart,
            checkedAt: provider.readiness.checkedAt,
          }
        : null,
      canRunD4Agent: supportsD4AgentDriver(provider.driver),
      supportedRuntimeModes: provider.supportedRuntimeModes ?? null,
      requiresNewThreadForModelChange: provider.requiresNewThreadForModelChange ?? null,
      quota: {
        state: quotaState,
        checkedAt: limits?.checkedAt ?? null,
        unavailableReason: limits?.unavailable?.reason ?? null,
        windows: windows.map(({ id, label, kind, usedPercent, resetsAt }) => ({
          id,
          label,
          kind,
          usedPercent,
          resetsAt: resetsAt ?? null,
        })),
      },
      models: provider.models
        .filter(
          (model) => !provider.updateRequiredModels?.some((entry) => entry.slug === model.slug),
        )
        .map((model) => ({
          slug: model.slug,
          name: model.name,
          isCustom: model.isCustom,
          capabilities: model.capabilities,
        })),
    };
  });
}
