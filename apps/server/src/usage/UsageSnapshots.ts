import {
  UsageDay,
  UsageReadError,
  type McpUsageLimitsInput,
  type McpUsageLimitsReport,
  type McpUsageReadInput,
  type UsageSummary,
} from "@d4research/contracts";
import { usageMcpSnapshot } from "@d4research/shared/usageMcpSnapshot";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Peers from "../peers/Peers.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageService from "./UsageService.ts";

export class UsageSnapshots extends Context.Service<
  UsageSnapshots,
  {
    readonly readLimits: (input: McpUsageLimitsInput) => Effect.Effect<McpUsageLimitsReport>;
    readonly readUsage: (input: McpUsageReadInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("d4research/usage/UsageSnapshots") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const usage = yield* UsageService.UsageService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peers = yield* Peers.Peers;
  return UsageSnapshots.of({
    readLimits: Effect.fn("UsageSnapshots.readLimits")(function* (input) {
      if (input.refresh)
        yield* Effect.all([registry.refresh(), sources.refresh], { concurrency: 2 });
      const providers = yield* registry.getProviders;
      const snapshots = yield* sources.current;
      const descriptor = yield* environment.getDescriptor;
      const local = usageMcpSnapshot(providers, snapshots, DateTime.formatIso(yield* DateTime.now));
      const report: McpUsageLimitsReport = {
        readAt: local.readAt,
        coverageComplete: true,
        notices: [],
        environments: [
          { environmentId: descriptor.environmentId, label: descriptor.label, available: true },
        ],
        providers: local.providers.map((provider) => ({
          ...provider,
          environmentId: descriptor.environmentId,
          environmentLabel: descriptor.label,
        })),
        sources: local.sources.map((source) => ({
          ...source,
          environmentId: descriptor.environmentId,
          environmentLabel: descriptor.label,
        })),
      };
      if (input.includeConnected === false) return report;
      const discovered = yield* peers
        .describe(null)
        .pipe(Effect.timeout("5 seconds"), Effect.result);
      if (discovered._tag === "Failure")
        return {
          ...report,
          coverageComplete: false,
          notices: [
            "Connected environments could not be discovered. Coverage is incomplete; keep the app open and connected to both machines. Local limits are not the whole Usage page.",
          ],
        };
      const remote = yield* Effect.forEach(
        discovered.success.filter((peer) => peer.environmentId !== descriptor.environmentId),
        (peer) =>
          Effect.gen(function* () {
            const identity = { environmentId: peer.environmentId, label: peer.label };
            if (!peer.connected)
              return {
                identity,
                snapshot: null,
                error: "This environment is disconnected; its quotas are unknown.",
              };
            const reply = yield* peers
              .request({
                type: "usage-limits",
                environmentId: peer.environmentId,
                refresh: input.refresh === true,
              })
              .pipe(Effect.timeout("20 seconds"), Effect.result);
            if (
              reply._tag === "Failure" ||
              reply.success.type !== "usage-limits" ||
              reply.success.environmentId !== peer.environmentId
            )
              return {
                identity,
                snapshot: null,
                error:
                  "Could not read this environment's usage. Keep an updated T3 app connected to both environments; its quotas remain unknown.",
              };
            return { identity, snapshot: reply.success.snapshot, error: undefined };
          }),
        { concurrency: 4 },
      );
      return {
        ...report,
        coverageComplete: remote.every((entry) => entry.snapshot !== null),
        environments: [
          ...report.environments,
          ...remote.map(({ identity, snapshot, error }) => ({
            ...identity,
            available: snapshot !== null,
            ...(error ? { error } : {}),
          })),
        ],
        providers: [
          ...report.providers,
          ...remote.flatMap(
            ({ identity, snapshot }) =>
              snapshot?.providers.map((provider) => ({
                ...provider,
                environmentId: identity.environmentId,
                environmentLabel: identity.label,
              })) ?? [],
          ),
        ],
        sources: [
          ...report.sources,
          ...remote.flatMap(
            ({ identity, snapshot }) =>
              snapshot?.sources.map((source) => ({
                ...source,
                environmentId: identity.environmentId,
                environmentLabel: identity.label,
              })) ?? [],
          ),
        ],
      };
    }),
    readUsage: Effect.fn("UsageSnapshots.readUsage")(function* (input) {
      const timeZone = input.timeZone ?? "UTC";
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const today = yield* Effect.try({
        try: () =>
          UsageDay.make(
            new Intl.DateTimeFormat("en-CA", {
              timeZone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(now),
          ),
        catch: () =>
          new UsageReadError({ reason: "invalidWindow", detail: "Invalid usage time zone." }),
      });
      return yield* usage.readSummary({
        ...input,
        timeZone,
        sinceDay: input.sinceDay ?? input.untilDay ?? today,
        untilDay: input.untilDay ?? today,
      });
    }),
  });
});

export const layer = Layer.effect(UsageSnapshots, make);
