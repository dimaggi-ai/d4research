import { EnvironmentRegistry, EnvironmentSupervisor } from "@d4research/client-runtime/connection";
import { makeEnvironmentHttpApiGroupClient } from "@d4research/client-runtime/rpc";
import { type EnvironmentId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  sharedEnvironmentPublication,
  type SharedHostConnection,
} from "../connection/sharedEnvironmentRoutes";

/** Publish live host routes, never credentials in a browser-readable catalog. No new SSH connection is opened. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined" || window.desktopBridge === undefined) return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const watchers = yield* FiberMap.make<EnvironmentId>();
    const state = yield* Ref.make(new Map<EnvironmentId, SharedHostConnection>());
    const signals = yield* Queue.sliding<void>(1);
    const signal = Queue.offer(signals, undefined);
    const tracked = yield* Ref.make(new Set<EnvironmentId>());
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          const old = yield* Ref.get(tracked);
          for (const id of old)
            if (!entries.has(id)) {
              yield* FiberMap.remove(watchers, id);
              yield* Ref.update(state, (current) => {
                const next = new Map(current);
                next.delete(id);
                return next;
              });
            }
          for (const [id, entry] of entries) {
            yield* Ref.update(state, (current) =>
              new Map(current).set(id, { entry, prepared: current.get(id)?.prepared ?? null }),
            );
            yield* FiberMap.run(
              watchers,
              id,
              registry
                .followStream(
                  id,
                  Stream.unwrap(
                    Effect.map(EnvironmentSupervisor.EnvironmentSupervisor, (supervisor) =>
                      Stream.zipLatest(
                        SubscriptionRef.changes(supervisor.prepared),
                        SubscriptionRef.changes(supervisor.state),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Stream.runForEach(([prepared, connection]) =>
                    Ref.update(state, (current) =>
                      new Map(current).set(id, {
                        entry: current.get(id)?.entry ?? entry,
                        prepared:
                          connection.phase === "connected" && Option.isSome(prepared)
                            ? prepared.value
                            : null,
                      }),
                    ).pipe(Effect.andThen(signal)),
                  ),
                ),
              { onlyIfMissing: true },
            );
          }
          yield* Ref.set(tracked, new Set(entries.keys()));
          yield* signal;
        }),
      ),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(signals).pipe(
      Stream.debounce("200 millis"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const current = [...(yield* Ref.get(state)).values()];
          const publication = sharedEnvironmentPublication(current);
          if (publication === null) return;
          const api = yield* makeEnvironmentHttpApiGroupClient(
            publication.httpBaseUrl,
            "sharedEnvironments",
          );
          yield* api.publish({ headers: publication.headers, payload: publication.payload }).pipe(
            Effect.retry({ times: 4, schedule: Schedule.exponential("1 second") }),
            Effect.catch(() =>
              Effect.logWarning(
                "Could not publish shared environments. The host server may need an update.",
              ),
            ),
          );
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
