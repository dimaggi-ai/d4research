import type { EnvironmentSupervisor } from "@d4research/client-runtime/connection";
import type { EnvironmentId } from "@d4research/contracts";
import { request, subscribe } from "@d4research/client-runtime/rpc";
import { WS_METHODS } from "@d4research/contracts";
import { usageMcpSnapshot } from "@d4research/shared/usageMcpSnapshot";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

type PeerUsageLimitsError =
  | Effect.Error<
      | ReturnType<typeof request<typeof WS_METHODS.serverGetConfig>>
      | ReturnType<typeof request<typeof WS_METHODS.serverRefreshProviders>>
    >
  | Stream.Error<ReturnType<typeof subscribe<typeof WS_METHODS.subscribeServerConfig>>>
  | Cause.NoSuchElementError
  | Cause.TimeoutError;

export const readPeerUsageLimits = Effect.fn("web.peerUsageLimits.read")(function* (
  refresh: boolean,
): Effect.fn.Return<
  { environmentId: EnvironmentId; snapshot: ReturnType<typeof usageMcpSnapshot> },
  PeerUsageLimitsError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  if (refresh) yield* request(WS_METHODS.serverRefreshProviders, { fresh: true });
  const config = yield* request(WS_METHODS.serverGetConfig, {});
  // Hub snapshots arrive on the config stream, rather than server.getConfig.
  const sources =
    config.usageLimitSources ??
    (config.environment.capabilities.usageLimitSources
      ? yield* subscribe(WS_METHODS.subscribeServerConfig, { usageLimitSources: true }).pipe(
          Stream.filter((event) => event.type === "usageLimitSourcesUpdated"),
          Stream.map((event) => event.payload.sources),
          Stream.runHead,
          Effect.flatMap(Effect.fromOption),
          Effect.timeout("10 seconds"),
        )
      : []);
  return {
    environmentId: config.environment.environmentId,
    snapshot: usageMcpSnapshot(config.providers, sources, DateTime.formatIso(yield* DateTime.now)),
  };
});
