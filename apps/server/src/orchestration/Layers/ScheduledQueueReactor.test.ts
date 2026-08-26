import { ThreadId, type OrchestrationCommand } from "@d4research/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionQueuedMessageRepository } from "../../persistence/Services/ProjectionQueuedMessages.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ScheduledQueueReactor } from "../Services/ScheduledQueueReactor.ts";
import { ScheduledQueueReactorLive } from "./ScheduledQueueReactor.ts";

const NOW = "2026-08-26T16:00:00.000Z";

it.effect("dispatches one drain per thread with due scheduled messages", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const threadId = ThreadId.make("scheduled-thread");
    const layer = ScheduledQueueReactorLive.pipe(
      Layer.provideMerge(
        Layer.mock(ProjectionQueuedMessageRepository)({
          listDue: () =>
            Effect.succeed([
              { threadId, messageId: "one", scheduledAt: NOW },
              { threadId, messageId: "two", scheduledAt: NOW },
            ] as never),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          dispatch: (command) =>
            Ref.update(commands, (existing) => [...existing, command]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* ScheduledQueueReactor;
      yield* reactor.runDue;
    }).pipe(Effect.provide(layer));

    const dispatched = yield* Ref.get(commands);
    assert.equal(dispatched.length, 1);
    const drain = dispatched[0];
    if (drain?.type !== "thread.queue.drain") return assert.fail("expected queue drain command");
    assert.equal(drain.threadId, threadId);
  }),
);
