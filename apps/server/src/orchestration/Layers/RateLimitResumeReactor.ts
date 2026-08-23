import { CommandId, EventId, MessageId } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionThreadResumeScheduleRepository } from "../../persistence/Services/ProjectionThreadResumeSchedule.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RateLimitResumeReactor,
  type RateLimitResumeReactorShape,
} from "../Services/RateLimitResumeReactor.ts";

export const RATE_LIMIT_RESUME_INTERVAL = Duration.seconds(60);
export const MAX_RATE_LIMIT_RESUME_ATTEMPTS = 3;

const make = Effect.gen(function* () {
  const repository = yield* ProjectionThreadResumeScheduleRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const deleteRow = (threadId: Parameters<typeof repository.deleteByThreadId>[0]["threadId"]) =>
    repository.deleteByThreadId({ threadId });

  const appendGaveUpActivity = Effect.fn("appendRateLimitResumeGaveUpActivity")(function* (
    row: Parameters<typeof repository.upsert>[0],
  ) {
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`auto-resume-gave-up:${row.threadId}:${row.createdAt}`),
      threadId: row.threadId,
      activity: {
        id: EventId.make(`auto-resume-gave-up:${row.threadId}:${row.createdAt}`),
        tone: "error",
        kind: "turn.auto-resume-gave-up",
        summary: "Automatic resume stopped",
        payload: {
          attempts: row.attempts,
          reason: row.reason,
          provider: row.provider,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const processRow = Effect.fn("processRateLimitResumeRow")(function* (
    row: Parameters<typeof repository.upsert>[0],
  ) {
    const thread = yield* projectionSnapshotQuery.getThreadShellById(row.threadId);
    if (Option.isNone(thread)) {
      yield* deleteRow(row.threadId);
      return;
    }

    const turnIsRunning =
      thread.value.latestTurn?.state === "running" ||
      thread.value.session?.status === "running" ||
      thread.value.session?.status === "starting";
    if (turnIsRunning) {
      yield* deleteRow(row.threadId);
      return;
    }

    if (row.attempts >= MAX_RATE_LIMIT_RESUME_ATTEMPTS) {
      yield* deleteRow(row.threadId);
      yield* appendGaveUpActivity(row);
      return;
    }

    const attempts = row.attempts + 1;
    yield* repository.upsert({ ...row, attempts });
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const commandKey = `${row.threadId}:${row.createdAt}:${attempts}`;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`auto-resume:${commandKey}`),
      threadId: row.threadId,
      message: {
        messageId: MessageId.make(`auto-resume:${commandKey}`),
        role: "user",
        text: row.prompt,
        attachments: [],
      },
      modelSelection:
        row.instanceId !== null && row.model !== null
          ? { instanceId: row.instanceId, model: row.model }
          : thread.value.modelSelection,
      titleSeed: thread.value.title,
      runtimeMode: thread.value.runtimeMode,
      interactionMode: thread.value.interactionMode,
      createdAt,
    });
    yield* deleteRow(row.threadId);
  });

  const runDue = Effect.gen(function* () {
    const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const dueRows = yield* repository.listDue({ now });
    yield* Effect.forEach(
      dueRows,
      (row) =>
        processRow(row).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning("rate-limit auto-resume attempt failed", {
              threadId: row.threadId,
              attempts: row.attempts + 1,
              cause: Cause.pretty(cause),
            });
          }),
        ),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }
      return Effect.logWarning("rate-limit auto-resume sweep failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const start: RateLimitResumeReactorShape["start"] = Effect.fn("startRateLimitResumeReactor")(
    function* () {
      yield* forkParked(runDue.pipe(Effect.repeat(Schedule.spaced(RATE_LIMIT_RESUME_INTERVAL))));
    },
  );

  return { start, runDue } satisfies RateLimitResumeReactorShape;
});

export const RateLimitResumeReactorLive = Layer.effect(RateLimitResumeReactor, make);
