import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@d4research/contracts";
import { makeDrainableWorker } from "@d4research/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import * as EventSink from "../EventSink.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { RESEARCH_INTEGRITY_WARNING_KIND, shouldWarnFakedPipeline } from "../researchIntegrity.ts";
import {
  ResearchIntegrityReactor,
  type ResearchIntegrityReactorShape,
} from "../Services/ResearchIntegrityReactor.ts";

const WARNING_COMMAND_TYPE = "research.integrity-warning";
const WARNING_TOOL_MESSAGE = "No research_delegate call was recorded for this run.";

type RunUpdatedEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

  const inspectCompletedRun = Effect.fn("ResearchIntegrityReactor.inspectCompletedRun")(function* (
    event: RunUpdatedEvent,
  ) {
    if (event.payload.status !== "completed") return;
    const threadId = event.threadId;
    const runId = event.payload.id;
    const commandId = CommandId.make(`server:research-integrity-warning:${runId}`);
    const records = yield* projectionStore.getThreadRecords(threadId, ["runs", "turnItems"], {
      runIds: [runId],
      turnItemRunId: runId,
      turnItemTypes: ["user_message", "assistant_message", "dynamic_tool", "system_notice"],
    });
    const completedRun = records.runs.find((run) => run.id === runId && run.status === "completed");
    if (completedRun === undefined || !shouldWarnFakedPipeline(records, runId)) return;

    const occurredAt = yield* DateTime.now;
    const itemId = idAllocator.derive.runSignalTurnItem({
      runId,
      signal: "research-integrity-warning",
    });
    const eventId = yield* idAllocator.allocate.event({ threadId, commandId });
    const rootNodeId = completedRun.rootNodeId;
    const warning: OrchestrationV2TurnItem = {
      id: itemId,
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: completedRun.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Research integrity warning",
      startedAt: occurredAt,
      completedAt: completedRun.completedAt ?? occurredAt,
      updatedAt: occurredAt,
      type: "system_notice",
      message: WARNING_TOOL_MESSAGE,
      activity: {
        kind: RESEARCH_INTEGRITY_WARNING_KIND,
        payload: { runId },
      },
    } as const;

    yield* eventSink.commitCommand({
      commandId,
      threadId,
      commandType: WARNING_COMMAND_TYPE,
      acceptedAt: occurredAt,
      events: [
        {
          id: eventId,
          threadId,
          runId,
          ...(rootNodeId === null ? {} : { nodeId: rootNodeId }),
          providerInstanceId: completedRun.providerInstanceId,
          occurredAt,
          type: "turn-item.updated",
          payload: warning,
        },
      ],
      effects: [],
    });
  });

  const inspectSafely = (event: OrchestrationV2DomainEvent) => {
    if (event.type !== "run.updated" || event.payload.status !== "completed") {
      return Effect.void;
    }
    return inspectCompletedRun(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("research integrity reactor failed to process completed run", {
              threadId: event.threadId,
              runId: event.payload.id,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  };

  const worker = yield* makeDrainableWorker(inspectSafely);
  const start: ResearchIntegrityReactorShape["start"] = Effect.fn("ResearchIntegrityReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated" && event.payload.status === "completed"
            ? worker.enqueue(event)
            : Effect.void,
        ),
      );
    },
  );

  return {
    start,
    drain: worker.drain,
  } satisfies ResearchIntegrityReactorShape;
});

export const ResearchIntegrityReactorLive = Layer.effect(ResearchIntegrityReactor, make);
