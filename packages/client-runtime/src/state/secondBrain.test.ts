import { EnvironmentId, WS_METHODS, type BrainStatus } from "@d4research/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  type PreparedConnection,
  type SupervisorConnectionState,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSecondBrainEnvironmentAtoms } from "./secondBrain.ts";

it.effect("refreshes only the requested environment's mounted brain queries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = EnvironmentId.make("first");
      const second = EnvironmentId.make("second");
      const reads = new Map<EnvironmentId, number>();
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      for (const environmentId of [first, second]) {
        const client = {
          [WS_METHODS.secondBrainStatus]: () =>
            Effect.sync(() => {
              const generation = (reads.get(environmentId) ?? 0) + 1;
              reads.set(environmentId, generation);
              return {
                enabled: true,
                vault: "/fixture",
                generation,
                notes: 1,
                chunks: 1,
                lastIndexedAt: null,
                semanticStatus: "disabled",
                truncated: false,
              } satisfies BrainStatus;
            }),
        };
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: "https://fixture.test",
              wsBaseUrl: "wss://fixture.test",
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!),
        followStream: (id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!),
      } as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
      const atoms = createSecondBrainEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const waitForGeneration = (id: EnvironmentId, generation: number) =>
        AtomRegistry.toStream(registry, atoms.secondBrainStatusQuery(id)).pipe(
          Stream.filter(
            (value) =>
              AsyncResult.isSuccess(value) &&
              !value.waiting &&
              value.value.generation === generation,
          ),
          Stream.runHead,
        );
      registry.mount(atoms.secondBrainStatusQuery(first));
      registry.mount(atoms.secondBrainStatusQuery(second));
      yield* waitForGeneration(first, 1);
      yield* waitForGeneration(second, 1);
      atoms.refresh(first, registry);
      yield* waitForGeneration(first, 2);
      expect(reads.get(first)).toBe(2);
      expect(reads.get(second)).toBe(1);
    }),
  ),
);
