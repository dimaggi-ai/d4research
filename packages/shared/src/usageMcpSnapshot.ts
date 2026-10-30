import {
  isProviderAvailable,
  type McpUsageLimitsSnapshot,
  type ServerProvider,
  type UsageLimitSourceSnapshots,
} from "@d4research/contracts";

export function usageMcpSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  sources: UsageLimitSourceSnapshots,
  readAt: string,
): McpUsageLimitsSnapshot {
  return {
    readAt,
    providers: providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName,
      enabled: provider.enabled,
      installed: provider.installed,
      available: isProviderAvailable(provider),
      auth: {
        status: provider.auth.status,
        label: provider.auth.label,
        email: provider.auth.email,
        workspaceId: provider.auth.workspaceId,
      },
      limits:
        provider.driver === "claudeAgent" &&
        provider.usageLimits?.unavailable?.reason === "unsupported"
          ? {
              ...provider.usageLimits,
              unavailable: {
                ...provider.usageLimits.unavailable,
                message:
                  provider.usageLimits.unavailable.message ??
                  "This Claude instance's authentication session does not expose subscription windows (for example token-only/API auth). Other Claude accounts or environments may report them; inspect all instances. This is not a claim that this app version cannot read Claude usage.",
              },
            }
          : (provider.usageLimits ?? null),
    })),
    sources,
  };
}
