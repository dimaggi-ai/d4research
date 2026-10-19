import { it, expect } from "@effect/vitest";
import { ThreadId, type OrchestrationV2StoredEvent } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Capture from "./SecondBrainCapture.ts";
import * as Reactor from "./SecondBrainCaptureReactor.ts";
import * as Index from "./SecondBrainIndex.ts";
import { withBrain } from "./testkit.ts";

it.effect(
  "replays successful terminal runs, coalesces per thread, drains, and persists the replay cursor",
  () =>
    withBrain(
      () =>
        Effect.gen(function* () {
          const index = yield* Index.SecondBrainIndex;
          const calls: string[] = [];
          const events = ["running", "failed", "interrupted", "completed", "completed"].map(
            (status, i) => ({
              sequence: i + 1,
              commandId: null,
              event: {
                type: "run.updated",
                threadId: ThreadId.make("t"),
                payload: { status, ordinal: i + 1 },
              },
            }),
          ) as unknown as OrchestrationV2StoredEvent[];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
            Layer.mock(EventStore.EventStoreV2)({
              read: (input) =>
                Stream.fromIterable(events.filter((e) => e.sequence > (input?.afterSequence ?? 0))),
            }),
            Layer.mock(Capture.SecondBrainCapture)({
              enqueue: (threadId, runTo) => {
                calls.push(`enqueue:${threadId}:${runTo}`);
                return index.enqueueCapture({
                  id: "job",
                  vault: "test",
                  threadId,
                  runFrom: 1,
                  runTo: runTo ?? 0,
                  transcriptHash: "hash",
                  version: "v1",
                  messages: [],
                  state: "pending",
                  proposalIds: [],
                });
              },
              process: (job) =>
                Effect.gen(function* () {
                  calls.push("process");
                  yield* index.saveCapture({ ...job, state: "completed" });
                  return [];
                }),
            }),
          );
          const run = Effect.gen(function* () {
            const reactor = yield* Reactor.SecondBrainCaptureReactor;
            yield* reactor.drain;
            yield* reactor.notify(events.at(-1)!.event);
            yield* reactor.drain;
          }).pipe(Effect.provide(Reactor.layer.pipe(Layer.provide(dependencies))));
          yield* run;
          expect(calls).toEqual(["enqueue:t:5", "process"]);
          expect(yield* index.captureCursor()).toBe(5);
          yield* run;
          expect(calls).toEqual(["enqueue:t:5", "process"]);
          yield* index.enqueueCapture({
            id: "restart-job",
            vault: "test",
            threadId: "t",
            runFrom: 1,
            runTo: 6,
            transcriptHash: "other",
            version: "v1",
            messages: [],
            state: "pending",
            proposalIds: [],
          });
          yield* run;
          expect(calls).toEqual(["enqueue:t:5", "process", "process"]);
          expect(yield* index.pendingCaptures()).toEqual([]);
        }),
      { capture: "proposals" },
    ),
);
it.effect("capture off advances the cursor without inference", () =>
  withBrain(() =>
    Effect.gen(function* () {
      const index = yield* Index.SecondBrainIndex;
      yield* Effect.gen(function* () {
        yield* (yield* Reactor.SecondBrainCaptureReactor).drain;
      }).pipe(
        Effect.provide(
          Reactor.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
                Layer.mock(EventStore.EventStoreV2)({
                  read: (input) =>
                    Stream.fromIterable(
                      input?.afterSequence
                        ? []
                        : [
                            {
                              sequence: 1,
                              commandId: null,
                              event: {
                                type: "run.updated",
                                threadId: ThreadId.make("t"),
                                payload: { status: "completed", ordinal: 1 },
                              },
                            } as unknown as OrchestrationV2StoredEvent,
                          ],
                    ),
                }),
                Layer.mock(Capture.SecondBrainCapture)({
                  enqueue: () => Effect.die("capture disabled"),
                }),
              ),
            ),
          ),
        ),
      );
      expect(yield* index.captureCursor()).toBe(1);
    }),
  ),
);
