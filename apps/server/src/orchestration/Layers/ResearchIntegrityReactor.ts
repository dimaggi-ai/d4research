import { CommandId, EventId, type OrchestrationEvent } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@d4research/shared/DrainableWorker";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ResearchIntegrityReactor,
  type ResearchIntegrityReactorShape,
} from "../Services/ResearchIntegrityReactor.ts";
import { RESEARCH_INTEGRITY_WARNING_KIND, shouldWarnFakedPipeline } from "../researchIntegrity.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type TurnDiffCompleted = Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const inspectCompletedTurn = Effect.fn("inspectCompletedTurn")(function* (
    event: TurnDiffCompleted,
  ) {
    const threadId = event.payload.threadId;
    const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
    if (Option.isNone(detail)) return;
    if (!shouldWarnFakedPipeline(detail.value, event.payload.turnId)) return;

    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("research-integrity-warning"),
      threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "error",
        kind: RESEARCH_INTEGRITY_WARNING_KIND,
        summary: "Pipeline ran no delegations",
        payload: {
          detail:
            "The orchestrator advanced this research/dev pipeline in prose but never called research_delegate, " +
            "so no sub-agent actually ran and nothing here was verified. A flash-tier orchestrator " +
            "tends to fake the pipeline — re-run with a stronger orchestrator model.",
        },
        turnId: event.payload.turnId,
        createdAt,
      },
      createdAt,
    });
  });

  const inspectSafely = (event: TurnDiffCompleted) =>
    inspectCompletedTurn(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("research integrity reactor failed to process turn", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(inspectSafely);

  const start: ResearchIntegrityReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-diff-completed") return Effect.void;
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ResearchIntegrityReactorShape;
});

export const ResearchIntegrityReactorLive = Layer.effect(ResearchIntegrityReactor, make);
