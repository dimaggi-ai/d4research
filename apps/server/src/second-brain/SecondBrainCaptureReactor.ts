import { type OrchestrationV2DomainEvent } from "@d4research/contracts";
import { makeDrainableWorker } from "@d4research/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Settings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Capture from "./SecondBrainCapture.ts";
import * as Index from "./SecondBrainIndex.ts";

export class SecondBrainCaptureReactor extends Context.Service<
  SecondBrainCaptureReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly notify: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("d4research/second-brain/SecondBrainCaptureReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const events = yield* EventStore.EventStoreV2;
  const settings = yield* Settings.ServerSettingsService;
  const capture = yield* Capture.SecondBrainCapture;
  const index = yield* Index.SecondBrainIndex;
  const scanLock = yield* Semaphore.make(1);
  const queued = new Set<string>();
  const worker = yield* makeDrainableWorker((job: Index.CaptureJob) =>
    capture.process(job).pipe(
      Effect.asVoid,
      Effect.catchCause(() => Effect.logWarning("Second brain capture failed", { jobId: job.id })),
      Effect.ensuring(
        Effect.sync(() => {
          queued.delete(job.id);
        }),
      ),
    ),
  );
  const queue = (job: Index.CaptureJob) =>
    Effect.gen(function* () {
      if (job.state !== "pending" || queued.has(job.id)) return;
      queued.add(job.id);
      yield* worker.enqueue(job);
    });
  const scan = scanLock.withPermits(1)(
    Effect.gen(function* () {
      const config = yield* settings.getSettings;
      const afterSequence = yield* index.captureCursor();
      let last = afterSequence;
      const threads = new Map<
        string,
        { threadId: OrchestrationV2DomainEvent["threadId"]; ordinal: number }
      >();
      yield* events.read({ afterSequence, limit: 1000 }).pipe(
        Stream.runForEach((stored) =>
          Effect.sync(() => {
            last = stored.sequence;
            const event = stored.event;
            if (
              event.type === "run.updated" &&
              event.payload.status === "completed" &&
              config.secondBrain.capture === "proposals" &&
              config.secondBrain.path
            ) {
              const previous = threads.get(event.threadId);
              if (!previous || previous.ordinal < event.payload.ordinal)
                threads.set(event.threadId, {
                  threadId: event.threadId,
                  ordinal: event.payload.ordinal,
                });
            }
          }),
        ),
      );
      for (const { threadId, ordinal } of threads.values())
        yield* queue(yield* capture.enqueue(threadId, ordinal));
      yield* index.setCaptureCursor(last);
      return last > afterSequence;
    }),
  );
  const replay = Effect.gen(function* () {
    while (yield* scan) {
      yield* Effect.yieldNow;
    }
  });
  const recover = Effect.gen(function* () {
    const config = yield* settings.getSettings;
    if (config.secondBrain.capture === "proposals" && config.secondBrain.path)
      for (const job of yield* index.pendingCaptures()) yield* queue(job);
    yield* replay;
  });
  const notify = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && event.payload.status === "completed"
      ? replay.pipe(
          Effect.catchCause(() => Effect.logWarning("Second brain capture replay failed")),
        )
      : Effect.void;
  return {
    notify,
    start: () =>
      Effect.gen(function* () {
        yield* forkParked(Stream.runForEach(engine.streamDomainEvents, notify));
        yield* forkParked(
          recover.pipe(
            Effect.catchCause(() => Effect.logWarning("Second brain capture recovery failed")),
          ),
        );
      }),
    drain: recover.pipe(
      Effect.catchCause(() => Effect.logWarning("Second brain capture replay failed")),
      Effect.andThen(worker.drain),
    ),
  } satisfies SecondBrainCaptureReactor["Service"];
});
export const layer = Layer.effect(SecondBrainCaptureReactor, make);
