import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ResearchIntegrityReactor } from "../Services/ResearchIntegrityReactor.ts";
import { RESEARCH_INTEGRITY_WARNING_KIND } from "../researchIntegrity.ts";
import { ResearchIntegrityReactorLive } from "./ResearchIntegrityReactor.ts";

const threadId = ThreadId.make("thread-integrity");
const turnId = TurnId.make("turn-integrity");

const fakedThread = {
  messages: [
    { role: "user", text: "!dev:default fix it", turnId },
    { role: "assistant", text: "[step 2 | visit 1] I built it", turnId },
  ],
  activities: [],
} as unknown as OrchestrationThread;

const completion = {
  type: "thread.turn-diff-completed",
  eventId: EventId.make("event-integrity"),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-08-08T00:00:00.000Z",
  commandId: CommandId.make("command-integrity"),
  causationEventId: null,
  correlationId: "command-integrity",
  metadata: {},
  payload: {
    threadId,
    turnId,
    checkpointTurnCount: 1,
    checkpointRef: "refs/t3/checkpoints/test",
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-08-08T00:00:00.000Z",
  },
} as unknown as OrchestrationEvent;

it.effect("appends one visible warning when a completed pipeline turn faked delegation", () =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const warningDispatched = yield* Deferred.make<void>();
    const engine = OrchestrationEngineService.of({
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(
          Effect.andThen(Deferred.succeed(warningDispatched, undefined)),
          Effect.as({ sequence: 1 }),
        ),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromIterable([completion]),
      latestSequence: Effect.succeed(0),
    });
    const layer = ResearchIntegrityReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.succeed(Option.some(fakedThread)),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* ResearchIntegrityReactor;
      yield* reactor.start();
      yield* Deferred.await(warningDispatched);
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(layer));

    const appended = yield* Ref.get(commands);
    assert.equal(appended.length, 1);
    const warning = appended[0];
    assert.equal(warning?.type, "thread.activity.append");
    if (warning?.type !== "thread.activity.append") return;
    assert.equal(warning.threadId, threadId);
    assert.equal(warning.activity.turnId, turnId);
    assert.equal(warning.activity.kind, RESEARCH_INTEGRITY_WARNING_KIND);
    assert.match(warning.activity.summary, /no delegations/i);
  }),
);
