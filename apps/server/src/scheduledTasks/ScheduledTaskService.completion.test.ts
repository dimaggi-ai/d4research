import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const input = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
  id: "task:completion",
  title: "Completion",
  prompt: "Run task",
  enabled: false,
  schedule: { type: "interval", everyMs: 60000 },
  projectId: "project:test",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

it.effect.each(
  (["completed", "failed", "interrupted", "cancelled"] as const).flatMap((terminal) =>
    (
      [
        "live",
        "terminal-restart",
        "pending-restart",
        "queued-restart",
        "unattached-restart",
      ] as const
    ).map((recovery) => ({
      terminal,
      recovery,
    })),
  ),
)("$terminal settles the dispatched run ($recovery)", ({ terminal, recovery }) => {
  const restart = recovery !== "live";
  const pendingAtRestart = ["pending-restart", "queued-restart", "unattached-restart"].includes(
    recovery,
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* Queue.unbounded<never>();
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(EventSink.EventSinkV2)({
        latestSequence: () => Effect.succeed(0),
        stream: () => Stream.fromQueue(events),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (launch) =>
          Effect.gen(function* () {
            const now = "2026-10-26T12:00:00.000Z";
            yield* sql`INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
              VALUES ('run:scheduled', 'thread:scheduled', 1, 'codex', 'running', ${now}, '{}')`;
            yield* sql`INSERT INTO orchestration_v2_projection_messages
              (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
              VALUES (${launch.initialMessage!.messageId}, 'thread:scheduled', 'run:scheduled', 'user', 0, ${now}, ${now}, '{}')`;
            return { threadId: "thread:scheduled", resumed: false } as never;
          }).pipe(Effect.orDie),
      }),
    );
    const build = Layer.build(ScheduledTaskService.layer.pipe(Layer.provide(dependencies)));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = Context.get(yield* build, ScheduledTaskService.ScheduledTaskService);
        const task = (yield* service.upsert(input)).task;
        const dispatched = (yield* service.runNow({ id: task.id })).task;
        assert.equal(dispatched.lastRunStatus, "running");
        assert.equal(dispatched.runCount, 0);
        assert.equal((yield* service.list()).tasks[0]?.lastRunStatus, "running");
        const overlap = yield* Effect.result(service.runNow({ id: task.id }));
        assert.equal(overlap._tag, "Failure");
        if (recovery === "queued-restart" || recovery === "unattached-restart") {
          yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'queued' WHERE run_id = 'run:scheduled'`;
        }
        if (recovery === "unattached-restart") {
          yield* sql`UPDATE orchestration_v2_projection_messages SET run_id = NULL WHERE run_id = 'run:scheduled'`;
        }
        if (!pendingAtRestart) {
          yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${terminal},
              completed_at = '2026-10-26T12:01:00.000Z' WHERE run_id = 'run:scheduled'`;
        }
        if (!restart) {
          const settled = yield* service.subscribeList().pipe(
            Stream.filter((list) => list.tasks[0]?.lastRunStatus !== "running"),
            Stream.runHead,
            Effect.forkChild,
          );
          // The stream payload is unused; the sink's run.updated notification triggers projection reconciliation.
          yield* Queue.offer(events, undefined as never);
          yield* Fiber.join(settled);
          const result = (yield* service.list()).tasks[0]!;
          assert.equal(result.lastRunStatus, terminal === "completed" ? "succeeded" : "failed");
          assert.equal(result.runCount, 1);
          const history = yield* service.completedRuns();
          assert.equal(history.length, 1);
          assert.equal(history[0]?.status, terminal === "completed" ? "succeeded" : "failed");
          assert.equal(history[0]?.taskId, input.id);
          assert.equal(history[0]?.projectId, input.projectId);
          assert.equal(history[0]?.title, input.title);
        }
      }),
    );
    if (restart) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = Context.get(yield* build, ScheduledTaskService.ScheduledTaskService);
          if (pendingAtRestart) {
            if (recovery === "unattached-restart") {
              yield* sql`UPDATE orchestration_v2_projection_messages SET run_id = 'run:scheduled' WHERE run_id IS NULL`;
            }
            assert.equal((yield* service.list()).tasks[0]?.lastRunStatus, "running");
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${terminal},
                  completed_at = '2026-10-26T12:01:00.000Z' WHERE run_id = 'run:scheduled'`;
            const settled = yield* service.subscribeList().pipe(
              Stream.filter((list) => list.tasks[0]?.lastRunStatus !== "running"),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Queue.offer(events, undefined as never);
            yield* Fiber.join(settled);
          }
          const result = (yield* service.list()).tasks[0]!;
          assert.equal(result.lastRunStatus, terminal === "completed" ? "succeeded" : "failed");
          assert.equal(result.runCount, 1);
          const history = yield* service.completedRuns();
          assert.equal(history.length, 1);
          assert.equal(history[0]?.status, terminal === "completed" ? "succeeded" : "failed");
          assert.equal(history[0]?.taskId, input.id);
          assert.equal(history[0]?.projectId, input.projectId);
          assert.equal(history[0]?.title, input.title);
        }),
      );
    }
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
});

it.effect(
  "retains distinct completed runs without their task and expires history after seven days",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const recent = DateTime.formatIso(now);
      const expired = DateTime.formatIso(DateTime.subtract(now, { days: 8 }));
      for (const [messageId, status, completedAt] of [
        ["message:first", "succeeded", recent],
        ["message:second", "failed", recent],
        ["message:expired", "succeeded", expired],
      ]) {
        yield* sql`INSERT INTO scheduled_task_runs
        (message_id, task_id, task_created_at, project_id, title, started_at, status, completed_at)
        VALUES (${messageId}, 'task:deleted', ${recent}, 'project:original', 'Original task', ${recent}, ${status}, ${completedAt})`;
      }
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.never,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            ScheduledTaskService.layer.pipe(Layer.provide(dependencies)),
          );
          const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
          assert.deepEqual(
            (yield* service.completedRuns()).map((run) => [
              run.messageId,
              run.status,
              run.title,
              run.projectId,
            ]),
            [
              ["message:first", "succeeded", "Original task", "project:original"],
              ["message:second", "failed", "Original task", "project:original"],
            ],
          );
          assert.deepEqual((yield* service.list()).tasks, []);
          const rows =
            yield* sql`SELECT message_id FROM scheduled_task_runs WHERE message_id = 'message:expired'`;
          assert.equal(rows.length, 0);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["deleted-task", "settled-before-read-error"] as const)(
  "keeps terminal history for dispatch edge: %s",
  (edge) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.never,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Effect.gen(function* () {
              if (edge === "deleted-task") {
                yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${input.id}`;
                return yield* Effect.die("Dispatch failed after deletion");
              }
              // A terminal event may settle history before a subsequent task read fails.
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`UPDATE scheduled_task_runs SET status = 'succeeded', completed_at = ${now} WHERE task_id = ${input.id}`;
              yield* sql`UPDATE scheduled_tasks SET schedule_json = 'invalid' WHERE task_id = ${input.id}`;
              return { threadId: "thread:scheduled", resumed: false } as never;
            }).pipe(Effect.orDie),
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            ScheduledTaskService.layer.pipe(Layer.provide(dependencies)),
          );
          const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
          const { task } = yield* service.upsert(input);
          const dispatched = yield* Effect.result(service.runNow({ id: task.id }));
          assert.equal(dispatched._tag, edge === "deleted-task" ? "Success" : "Failure");
          const history = yield* service.completedRuns();
          assert.equal(history.length, 1);
          assert.equal(history[0]?.status, edge === "deleted-task" ? "failed" : "succeeded");
          assert.equal(history[0]?.title, input.title);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
