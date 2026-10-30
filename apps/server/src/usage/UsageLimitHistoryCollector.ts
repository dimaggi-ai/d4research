import type {
  ServerProvider,
  UsageLimitSourceSnapshot,
  UsageLimitHistoryPoint,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { UsageLimitSources } from "./UsageLimitSources.ts";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";

export function providerHistoryPoints(
  providers: readonly ServerProvider[],
): UsageLimitHistoryPoint[] {
  return providers.flatMap((provider) => {
    const limits = provider.usageLimits;
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status !== "authenticated" ||
      !limits ||
      limits.unavailable
    )
      return [];
    // A login switch on the same instance must start a different history, not join two accounts.
    const accountId = JSON.stringify([
      "provider",
      provider.driver,
      provider.instanceId,
      provider.auth.email?.trim().toLowerCase() ?? null,
    ]);
    return limits.windows.map((window) => ({
      accountId,
      label: provider.displayName || String(provider.instanceId),
      color: provider.accentColor ?? null,
      windowId: window.id,
      windowLabel: window.label,
      measuredAt: limits.checkedAt,
      remainingPercent: 100 - window.usedPercent,
      resetsAt: window.resetsAt ?? null,
    }));
  });
}

export function sourceHistoryPoints(
  sources: readonly UsageLimitSourceSnapshot[],
): UsageLimitHistoryPoint[] {
  return sources.flatMap((source) =>
    source.error
      ? []
      : source.accounts.flatMap((account) =>
          account.usageLimits.unavailable
            ? []
            : account.usageLimits.windows.map((window) => ({
                accountId: JSON.stringify(["source", source.id, account.driver, account.id]),
                label: `${source.label} · ${account.id}`,
                color: null,
                windowId: window.id,
                windowLabel: window.label,
                measuredAt: account.usageLimits.checkedAt,
                remainingPercent: 100 - window.usedPercent,
                resetsAt: window.resetsAt ?? null,
              })),
        ),
  );
}

// Managed providers and external sources already poll periodically, including while no page is open.
// Observe those measurements instead of launching duplicate probes or recording stale cached values as new.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const history = yield* UsageLimitHistory;
    const providers = yield* ProviderRegistry;
    const sources = yield* UsageLimitSources;
    yield* providers.streamChanges.pipe(
      Stream.runForEach((snapshots) =>
        history.record(providerHistoryPoints(snapshots)).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      const providerSnapshot = yield* providers.getProviders;
      const sourceSnapshot = yield* sources.current;
      yield* history.record([
        ...providerHistoryPoints(providerSnapshot),
        ...sourceHistoryPoints(sourceSnapshot),
      ]);
    }).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced("5 minutes")),
      Effect.forkScoped,
    );
  }),
);
