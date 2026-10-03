import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@d4research/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "../EventSink.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { ResearchIntegrityReactor } from "../Services/ResearchIntegrityReactor.ts";
import { RESEARCH_INTEGRITY_WARNING_KIND } from "../researchIntegrity.ts";
import { ResearchIntegrityReactorLive } from "./ResearchIntegrityReactor.ts";

const threadId = ThreadId.make("thread-integrity");
const runId = RunId.make("run-integrity");

const completedRun = {
  type: "run.updated",
  eventId: EventId.make("event-run-completed"),
  threadId,
  occurredAt: "2026-10-02T12:00:00.000Z",
  payload: {
    id: runId,
    status: "completed",
  },
} as unknown as OrchestrationV2DomainEvent;

const records = {
  thread: {},
  runs: [{ id: runId, status: "completed", rootNodeId: null, providerThreadId: null }],
  turnItems: [
    {
      id: "user-item",
      runId,
      type: "user_message",
      text: "!dev:default fix it",
    },
    {
      id: "assistant-item",
      runId,
      type: "assistant_message",
      text: "[step 2 | visit 1] I built it",
    },
  ],
} as const;

it.effect("commits one visible V2 warning for a completed fake pipeline run", () =>
  Effect.gen(function* () {
    type CommitInput = Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0];
    const committed = yield* Deferred.make<CommitInput>();
    const commandId = CommandId.make("server:research-integrity-warning:run-integrity");

    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromIterable([completedRun]),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>() =>
          Effect.succeed(records as unknown as ProjectionStore.ProjectionRecords<K>),
      }),
      Layer.mock(EventSink.EventSinkV2)({
        commitCommand: (input) => Deferred.succeed(committed, input).pipe(Effect.as({} as never)),
      }),
      Layer.succeed(
        IdAllocator.IdAllocatorV2,
        IdAllocator.IdAllocatorV2.of({
          allocate: {
            event: () => Effect.succeed(EventId.make("event-integrity-warning")),
          },
          derive: {
            runSignalTurnItem: () => "turn-item-integrity-warning" as never,
          },
        } as unknown as IdAllocator.IdAllocatorV2["Service"]),
      ),
    );
    const layer = ResearchIntegrityReactorLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const reactor = yield* ResearchIntegrityReactor;
      yield* reactor.start();
      const input = yield* Deferred.await(committed);
      yield* reactor.drain;

      assert.equal(input.commandId, commandId);
      assert.equal(input.threadId, threadId);
      assert.equal(input.commandType, "research.integrity-warning");
      assert.equal(input.effects.length, 0);
      assert.equal(input.events.length, 1);
      const warning = input.events[0];
      assert.equal(warning?.type, "turn-item.updated");
      if (warning?.type !== "turn-item.updated") return;
      assert.equal(warning.payload.type, "system_notice");
      if (warning.payload.type !== "system_notice") return;
      assert.equal(warning.payload.message, "No research_delegate call was recorded for this run.");
      assert.equal(warning.payload.activity?.kind, RESEARCH_INTEGRITY_WARNING_KIND);
      assert.deepEqual(warning.payload.activity?.payload, { runId });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);
