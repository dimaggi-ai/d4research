import {
  EnvironmentRegistry,
  ConnectionTransientError,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  isSharedHostConnectionTarget,
  sharedEnvironmentRegistrations,
  type ConnectionCatalogEntry,
  type PreparedConnection,
  type PrimaryConnectionRegistration,
} from "@d4research/client-runtime/connection";
import { environmentEndpointUrl } from "@d4research/client-runtime/environment";
import { SharedEnvironmentCatalog, type EnvironmentId } from "@d4research/contracts";
import { environmentGatewayPath } from "@d4research/shared/environmentGateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";

export const discoverSharedHostEnvironments = Effect.fn("mobile.sharedEnvironments.discover")(
  function* (host: PreparedConnection) {
    if (
      host.target._tag !== "BearerConnectionTarget" ||
      host.httpAuthorization?._tag !== "Bearer" ||
      environmentGatewayPath(host.httpBaseUrl) !== ""
    ) {
      return Option.some<ReadonlyArray<PrimaryConnectionRegistration>>([]);
    }
    const connectionId = host.target.connectionId;
    const http = yield* HttpClient.HttpClient;
    return yield* http
      .get(environmentEndpointUrl(host.httpBaseUrl, "/api/shared-environments"), {
        headers: { authorization: `Bearer ${host.httpAuthorization.token}` },
      })
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            // Revocation and older hosts are authoritative; transport failures retain the last catalog.
            if ([401, 403, 404].includes(response.status)) return [];
            if (response.status !== 200)
              return yield* new ConnectionTransientError({
                reason: "endpoint-unavailable",
                detail: "The host's shared environment catalog is temporarily unavailable.",
              });
            const catalog =
              yield* HttpClientResponse.schemaBodyJson(SharedEnvironmentCatalog)(response);
            return sharedEnvironmentRegistrations(
              new PrimaryConnectionTarget({
                environmentId: host.environmentId,
                label: host.label,
                httpBaseUrl: host.httpBaseUrl,
                wsBaseUrl: host.socketUrl,
              }),
              catalog,
              { environmentId: host.environmentId, connectionId },
            );
          }),
        ),
        Effect.timeout("5 seconds"),
        Effect.option,
      );
  },
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const discovered = new Map<EnvironmentId, ReadonlyArray<PrimaryConnectionRegistration>>();
    const parents = (entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>) =>
      [...entries.values()].filter(
        (entry) => entry.enabled && entry.target._tag === "BearerConnectionTarget",
      );
    const refresh = Effect.fn("mobile.sharedEnvironments.refresh")(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      const hosts = parents(entries);
      const enabled = new Set(hosts.map((entry) => entry.target.environmentId));
      for (const id of discovered.keys()) if (!enabled.has(id)) discovered.delete(id);
      yield* Effect.forEach(
        hosts,
        (entry) =>
          Effect.gen(function* () {
            const current = yield* registry
              .followStream(
                entry.target.environmentId,
                Stream.fromEffect(
                  Effect.gen(function* () {
                    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                    const state = yield* SubscriptionRef.get(supervisor.state);
                    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
                    return state.phase === "connected" ? Option.getOrNull(prepared) : null;
                  }),
                ),
              )
              .pipe(
                Stream.runHead,
                Effect.timeout("2 seconds"),
                Effect.catch(() => Effect.succeedNone),
              );
            const host = Option.getOrNull(current);
            if (!host) return;
            const result = yield* discoverSharedHostEnvironments(host);
            if (Option.isSome(result)) discovered.set(entry.target.environmentId, result.value);
          }),
        { concurrency: 4, discard: true },
      );
      const seen = new Set<EnvironmentId>();
      const registrations = [...discovered.values()].flat().filter((registration) => {
        const id = registration.target.environmentId;
        const existing = entries.get(id);
        if (seen.has(id) || (existing && !isSharedHostConnectionTarget(existing.target)))
          return false;
        seen.add(id);
        return true;
      });
      // Mobile has no desktop-local platform registrations. User-paired routes remain authoritative.
      yield* registry.reconcilePlatform(registrations);
    });
    yield* Stream.merge(
      SubscriptionRef.changes(registry.entries).pipe(
        Stream.map(parents),
        Stream.changesWith(
          (before, after) =>
            before.length === after.length &&
            before.every((entry, index) => entry === after[index]),
        ),
      ),
      Stream.tick("10 seconds").pipe(Stream.drop(1)),
    ).pipe(Stream.runForEach(refresh), Effect.forkScoped);
  }),
);
