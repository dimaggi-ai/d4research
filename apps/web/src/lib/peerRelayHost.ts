import { EnvironmentRegistry } from "@d4research/client-runtime/connection";
import { request, subscribe } from "@d4research/client-runtime/rpc";
import { readPeerUsageLimits } from "./peerUsageLimits";
import {
  type EnvironmentId,
  PeerFilesError,
  OrchestratorMcpFailure,
  type PeerRelayOperation,
  type PeerRelayReply,
  type ProjectId,
  WS_METHODS,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Semaphore from "effect/Semaphore";

const isPeerFilesError = Schema.is(PeerFilesError);
const isThreadError = Schema.is(OrchestratorMcpFailure);

const unreachable = (message: string): PeerRelayReply => ({
  type: "failed",
  code: "peer_unreachable",
  message,
});

/**
 * Environments never connect to each other, so this app relays file and conversation requests
 * from the agent's server through the user's existing connection to the destination. See `packages/contracts/src/peers.ts`.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const relays = yield* FiberMap.make<EnvironmentId>();
    const fileSlots = yield* Semaphore.make(4);

    const describe = Effect.fn("web.peerRelay.describe")(function* (
      source: EnvironmentId,
      projectId: ProjectId | null,
    ) {
      const entries = yield* SubscriptionRef.get(registry.entries);
      // Loaded on demand: the project state imports the connection runtime this layer is part of.
      const { peerProjects } = yield* Effect.promise(() => import("../peerProjects"));
      const peers = yield* Effect.forEach(
        Array.from(entries.values()).filter((entry) => entry.target.environmentId !== source),
        ({ target }) =>
          registry.state(target.environmentId).pipe(
            Effect.map((state) => state.phase === "connected"),
            Effect.orElseSucceed(() => false),
            Effect.map((connected) => ({
              environmentId: target.environmentId,
              label: target.label,
              connected,
              projects: peerProjects(target.environmentId, { environmentId: source, projectId }),
            })),
          ),
      );
      return { type: "described", peers } satisfies PeerRelayReply;
    });

    const onPeer = <A, E extends { readonly _tag: string }, R>(
      source: EnvironmentId,
      target: EnvironmentId,
      call: Effect.Effect<A, E, R>,
      reply: (result: A) => PeerRelayReply,
    ) =>
      target === source
        ? Effect.succeed(unreachable("That is this environment itself. Work on its files here."))
        : registry.run(target, call).pipe(
            Effect.map(reply),
            Effect.catch((error) =>
              Effect.succeed(
                isPeerFilesError(error)
                  ? ({ type: "failed", code: error.code, message: error.message } as const)
                  : unreachable(`The app could not reach that environment (${error._tag}).`),
              ),
            ),
          );

    const perform = (source: EnvironmentId, operation: PeerRelayOperation) => {
      switch (operation.type) {
        case "usage-limits":
          return onPeer(
            source,
            operation.environmentId,
            readPeerUsageLimits(operation.refresh),
            (result) => ({ type: "usage-limits", ...result }),
          );
        case "describe":
          return describe(source, operation.projectId);
        case "threads-list":
        case "thread-read":
        case "thread-send":
        case "thread-wait":
          return Effect.promise(() => import("../rpc/peerThreads")).pipe(
            Effect.flatMap((rpc) => rpc.perform(operation.environmentId, operation)),
            Effect.catch((error) =>
              Effect.succeed<PeerRelayReply>(
                isThreadError(error)
                  ? { type: "failed", code: error.code, message: error.message }
                  : unreachable(
                      "The destination app/server could not accept the thread request. Connect both environments with matching versions.",
                    ),
              ),
            ),
          );
        case "list":
          return fileSlots.withPermits(1)(
            onPeer(
              source,
              operation.environmentId,
              request(WS_METHODS.peerFilesList, operation.input),
              (result) => ({ type: "listed", result }),
            ),
          );
        case "read":
          return fileSlots.withPermits(1)(
            onPeer(
              source,
              operation.environmentId,
              request(WS_METHODS.peerFilesRead, operation.input),
              (result) => ({ type: "read", result }),
            ),
          );
        case "write":
          return fileSlots.withPermits(1)(
            onPeer(
              source,
              operation.environmentId,
              request(WS_METHODS.peerFilesWrite, operation.input),
              (result) => ({ type: "written", result }),
            ),
          );
      }
    };

    // A server without the relay RPC fails the subscription; ask again later in case it updates.
    const serve = (source: EnvironmentId) =>
      registry.followStream(source, subscribe(WS_METHODS.peerRelayConnect, {})).pipe(
        Stream.mapEffect(
          ({ requestId, operation }) =>
            perform(source, operation).pipe(
              Effect.flatMap((reply) =>
                registry.run(source, request(WS_METHODS.peerRelayRespond, { requestId, reply })),
              ),
              Effect.ignoreCause,
            ),
          { concurrency: 32, unordered: true },
        ),
        Stream.runDrain,
        Effect.ignoreCause,
        Effect.andThen(Effect.sleep("60 seconds")),
        Effect.forever,
      );

    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.forEach(
          entries.keys(),
          (environmentId) =>
            FiberMap.run(relays, environmentId, serve(environmentId), { onlyIfMissing: true }),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
