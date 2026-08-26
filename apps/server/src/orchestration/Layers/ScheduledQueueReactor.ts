import { CommandId } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProjectionQueuedMessageRepository } from "../../persistence/Services/ProjectionQueuedMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ScheduledQueueReactor,
  type ScheduledQueueReactorShape,
} from "../Services/ScheduledQueueReactor.ts";

export const SCHEDULED_QUEUE_INTERVAL = Duration.seconds(1);

const make = Effect.gen(function* () {
  const repository = yield* ProjectionQueuedMessageRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const runDue = Effect.gen(function* () {
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const due = yield* repository.listDue({ now });
    const threadIds = [...new Set(due.map((row) => row.threadId))];
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        orchestrationEngine
          .dispatch({
            type: "thread.queue.drain",
            commandId: CommandId.make(`scheduled-queue:${threadId}:${now}`),
            threadId,
            createdAt: now,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logDebug("scheduled queue entry remains pending", {
                    threadId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("scheduled queue sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start: ScheduledQueueReactorShape["start"] = Effect.fn("startScheduledQueueReactor")(
    function* () {
      yield* forkParked(runDue.pipe(Effect.repeat(Schedule.spaced(SCHEDULED_QUEUE_INTERVAL))));
    },
  );
  return { start, runDue } satisfies ScheduledQueueReactorShape;
});

export const ScheduledQueueReactorLive = Layer.effect(ScheduledQueueReactor, make);
