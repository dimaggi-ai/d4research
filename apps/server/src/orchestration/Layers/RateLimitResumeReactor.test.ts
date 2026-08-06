import { ProviderInstanceId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProjectionThreadResumeScheduleRepository,
  type ProjectionThreadResumeSchedule,
} from "../../persistence/Services/ProjectionThreadResumeSchedule.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RateLimitResumeReactor } from "../Services/RateLimitResumeReactor.ts";
import { RateLimitResumeReactorLive } from "./RateLimitResumeReactor.ts";

const NOW = "2026-08-05T10:00:00.000Z";

const baseRow: ProjectionThreadResumeSchedule = {
  threadId: ThreadId.make("thread-rate-limit"),
  resumeAt: NOW,
  reason: "Rate limit reached",
  provider: "codex",
  instanceId: ProviderInstanceId.make("codex-work"),
  model: "gpt-5.6-sol",
  prompt: "Continue the previous task.",
  createdAt: "2026-08-05T09:00:00.000Z",
  attempts: 0,
};

const activeThreadShell = {
  id: baseRow.threadId,
  projectId: "project-rate-limit",
  title: "Rate limited thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex-work"),
    model: "gpt-5.6-sol",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: "failed-turn",
    state: "error",
    requestedAt: "2026-08-05T09:00:00.000Z",
    startedAt: "2026-08-05T09:00:01.000Z",
    completedAt: "2026-08-05T09:01:00.000Z",
    assistantMessageId: null,
  },
  createdAt: "2026-08-05T08:00:00.000Z",
  updatedAt: "2026-08-05T09:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: "2026-08-05T09:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

function makeTestLayer(input: {
  readonly rows: Ref.Ref<ReadonlyArray<ProjectionThreadResumeSchedule>>;
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly failTurnStarts?: boolean;
}) {
  const repository = ProjectionThreadResumeScheduleRepository.of({
    upsert: (row) =>
      Ref.update(input.rows, (rows) => [
        ...rows.filter((candidate) => candidate.threadId !== row.threadId),
        row,
      ]),
    listDue: ({ now }) =>
      Ref.get(input.rows).pipe(Effect.map((rows) => rows.filter((row) => row.resumeAt <= now))),
    getByThreadId: ({ threadId }) =>
      Ref.get(input.rows).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows.find((row) => row.threadId === threadId))),
      ),
    deleteByThreadId: ({ threadId }) =>
      Ref.update(input.rows, (rows) => rows.filter((candidate) => candidate.threadId !== threadId)),
  });
  const engine = OrchestrationEngineService.of({
    dispatch: (command) =>
      Ref.update(input.commands, (commands) => [...commands, command]).pipe(
        Effect.andThen(
          input.failTurnStarts && command.type === "thread.turn.start"
            ? Effect.die("simulated dispatch failure")
            : Effect.succeed({ sequence: 1 }),
        ),
      ),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });

  return RateLimitResumeReactorLive.pipe(
    Layer.provideMerge(Layer.succeed(ProjectionThreadResumeScheduleRepository, repository)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.some(activeThreadShell as never)),
      }),
    ),
  );
}

it.effect("dispatches one due turn start and deletes its schedule", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const rows = yield* Ref.make<ReadonlyArray<ProjectionThreadResumeSchedule>>([baseRow]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    yield* Effect.gen(function* () {
      const reactor = yield* RateLimitResumeReactor;
      yield* reactor.runDue;
    }).pipe(Effect.provide(makeTestLayer({ rows, commands })));

    assert.deepEqual(yield* Ref.get(rows), []);
    const dispatched = yield* Ref.get(commands);
    assert.equal(dispatched.filter((command) => command.type === "thread.turn.start").length, 1);
    const turnStart = dispatched.find((command) => command.type === "thread.turn.start");
    if (turnStart?.type !== "thread.turn.start") {
      return assert.fail("expected a turn start command");
    }
    assert.equal(turnStart.message.text, baseRow.prompt);
    assert.deepEqual(turnStart.modelSelection, {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
    });
  }),
);

it.effect("caps failed automatic resume attempts at three and emits a give-up activity", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const rows = yield* Ref.make<ReadonlyArray<ProjectionThreadResumeSchedule>>([
      { ...baseRow, attempts: 2 },
    ]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const layer = makeTestLayer({ rows, commands, failTurnStarts: true });

    yield* Effect.gen(function* () {
      const reactor = yield* RateLimitResumeReactor;
      yield* reactor.runDue;
      yield* TestClock.adjust("60 seconds");
      yield* reactor.runDue;
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(rows), []);
    const dispatched = yield* Ref.get(commands);
    assert.equal(dispatched.filter((command) => command.type === "thread.turn.start").length, 1);
    const gaveUp = dispatched.find((command) => command.type === "thread.activity.append");
    if (gaveUp?.type !== "thread.activity.append") {
      return assert.fail("expected a give-up activity command");
    }
    assert.equal(gaveUp.activity.kind, "turn.auto-resume-gave-up");
  }),
);
