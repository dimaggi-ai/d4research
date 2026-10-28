import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OverviewThreads from "./OverviewThreads.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const now = Date.parse("2026-10-26T19:00:00.000Z");
const day = 86_400_000;
const layer = OverviewThreads.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const insert = Effect.fnUntraced(function* (input: {
  id: string;
  threadId?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  status?: string;
  ordinal?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const completedAt = input.completedAt === undefined ? now : input.completedAt;
  const startedAt = input.startedAt === undefined ? now - 300_000 : input.startedAt;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_instance_id, status,
      requested_at, completed_at, payload_json
    ) VALUES (
      ${input.id}, ${input.threadId ?? input.id}, ${input.ordinal ?? 1}, 'codex', 'codex',
      ${input.status ?? "completed"}, ${iso(now - day)},
      ${completedAt === null ? null : iso(completedAt)},
      ${encode({ startedAt: startedAt === null ? null : iso(startedAt) })}
    )
  `;
});

it.effect("includes exactly five minutes and longer, excluding shorter or unknown duration", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* insert({ id: "boundary", startedAt: now - 300_000 });
    yield* insert({ id: "short", startedAt: now - 299_999 });
    yield* insert({ id: "long", startedAt: now - 300_001 });
    yield* insert({ id: "unknown", startedAt: null });
    const completed = yield* (yield* OverviewThreads.OverviewThreads).readCompleted();
    assert.deepEqual(
      completed.map((row) => row.runId),
      ["boundary", "long"],
    );
    assert.deepEqual(completed[0], {
      threadId: ThreadId.make("boundary"),
      runId: "boundary",
      ordinal: 1,
      status: "completed",
      completedAt: iso(now),
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "includes completed, interrupted and cancelled runs, excluding failed and active runs",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      for (const status of [
        "completed",
        "failed",
        "interrupted",
        "cancelled",
        "running",
        "queued",
      ]) {
        yield* insert({ id: status, status });
      }
      yield* insert({ id: "no-completion", completedAt: null });
      const completed = yield* (yield* OverviewThreads.OverviewThreads).readCompleted();
      assert.deepEqual(completed.map((row) => [row.runId, row.status]).sort(), [
        ["cancelled", "cancelled"],
        ["completed", "completed"],
        ["interrupted", "interrupted"],
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps seven-day boundary, excludes older and future results, and returns newest first",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      for (const [id, completedAt] of [
        ["seven-days", now - 7 * day],
        ["old", now - 7 * day - 1],
        ["recent", now - day],
        ["newest", now],
        ["future", now + 1],
      ] as const) {
        yield* insert({ id, completedAt, startedAt: completedAt - 300_000 });
      }
      const completed = yield* (yield* OverviewThreads.OverviewThreads).readCompleted();
      assert.deepEqual(
        completed.map((row) => row.runId),
        ["newest", "recent", "seven-days"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("returns no historical result when the same thread has a newer active run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* insert({
      id: "finished-first",
      threadId: "shared",
      ordinal: 1,
      completedAt: now - 600_000,
      startedAt: now - 900_000,
    });
    yield* insert({
      id: "finished-second",
      threadId: "shared",
      ordinal: 2,
      completedAt: now - 300_000,
      startedAt: now - 600_000,
    });
    yield* insert({
      id: "active-third",
      threadId: "shared",
      ordinal: 3,
      status: "running",
      completedAt: null,
    });
    const service = yield* OverviewThreads.OverviewThreads;
    const completed = yield* service.readCompleted();
    assert.deepEqual(completed, []);
    assert.deepEqual(yield* service.readCompleted(), completed);
  }).pipe(Effect.provide(layer)),
);

it.effect("returns only the newest run when a short completion follows a cancellation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* insert({
      id: "cancelled-first",
      threadId: "shared",
      ordinal: 1,
      status: "cancelled",
      completedAt: now - 60_000,
    });
    yield* insert({
      id: "quick-success",
      threadId: "shared",
      ordinal: 2,
      status: "completed",
      startedAt: now - 20_000,
    });
    assert.deepEqual(yield* (yield* OverviewThreads.OverviewThreads).readCompleted(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("returns a typed error when projection metadata cannot be read", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE orchestration_v2_projection_runs`;
    const result = yield* Effect.result((yield* OverviewThreads.OverviewThreads).readCompleted());
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, OverviewThreads.OverviewThreadsError);
      assert.isDefined(result.failure.cause);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("scheduled completions are reported only by the scheduled source", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* insert({ id: "scheduled" });
    yield* insert({ id: "ordinary" });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('scheduled-message', 'scheduled', 'scheduled', 'user', 0, ${iso(now)}, ${iso(now)}, '{"scheduledTaskId":"task"}')`;
    const completed = yield* (yield* OverviewThreads.OverviewThreads).readCompleted();
    assert.deepEqual(
      completed.map((run) => run.runId),
      ["ordinary"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("reports cancelled and interrupted runs with their status, regardless of duration", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* insert({ id: "cut", status: "cancelled", startedAt: now - 20_000, ordinal: 3 });
    yield* insert({ id: "halted", status: "interrupted", startedAt: now - 1_000, ordinal: 2 });
    yield* insert({ id: "never-started", status: "cancelled", startedAt: null });
    yield* insert({ id: "broken", status: "failed", startedAt: now - 20_000 });
    yield* insert({ id: "quick", status: "completed", startedAt: now - 20_000 });
    const runs = yield* (yield* OverviewThreads.OverviewThreads).readCompleted();
    assert.deepEqual(
      runs.map((row) => [row.runId, row.status, row.ordinal]),
      [
        ["cut", "cancelled", 3],
        ["halted", "interrupted", 2],
      ],
    );
  }).pipe(Effect.provide(layer)),
);
