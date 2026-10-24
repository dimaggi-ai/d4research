// @effect-diagnostics nodeBuiltinImport:off -- Synchronous temporary fixtures verify database close and reopen.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import migration from "../persistence/Migrations/074_RouteTelemetry.ts";
import * as RouteTelemetry from "./RouteTelemetry.ts";

const start = {
  threadId: "thread-private",
  runId: "run-private",
  driver: "opencode",
  instanceId: "local-private",
  model: "model-private",
  reason: "local_healthy",
  health: "healthy",
  startedAt: 1000,
  contextTokens: 300,
  fallback: true,
} as const;
const provide = <A, E>(
  effect: Effect.Effect<A, E, RouteTelemetry.RouteTelemetry | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.provideMerge(
        RouteTelemetry.layer,
        Layer.provideMerge(
          Layer.effectDiscard(migration),
          NodeSqliteClient.layer({ filename: ":memory:" }),
        ),
      ),
    ),
  );

it.effect("keeps starts and terminal events idempotent and drops unknown private fields", () =>
  provide(
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      const injected = {
        ...start,
        prompt: "SECRET-PROMPT",
        cwd: "/SECRET-PATH",
        error: "SECRET-ERROR",
      };
      yield* telemetry.recordStart(injected);
      yield* telemetry.recordStart({ ...start, fallback: false });
      yield* telemetry.recordEnd(start.runId, {
        endedAt: 1600,
        outcome: "failed",
        inputTokens: 17,
        outputTokens: 29,
        timeout: true,
      });
      yield* telemetry.recordEnd(start.runId, { endedAt: 1900, outcome: "completed" });
      const rows = yield* sql`SELECT * FROM provider_route_telemetry`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.failures, 1);
      assert.equal(rows[0]?.fallbacks, 1);
      assert.equal(rows[0]?.input_tokens, 17);
      assert.equal(rows[0]?.output_tokens, 29);
      assert.equal(rows[0]?.context_tokens, 300);
      for (const secret of [
        start.threadId,
        start.runId,
        start.instanceId,
        start.model,
        injected.prompt,
        injected.cwd,
        injected.error,
      ]) {
        assert.notInclude(JSON.stringify(rows), secret);
      }
      assert.deepEqual(yield* telemetry.recent(start.instanceId, start.model, 2000), [
        { latencyMs: 600, outcome: "failed", timeout: true },
      ]);
      assert.deepEqual(yield* telemetry.recent("other", start.model, 2000), []);
    }),
  ),
);

it.effect("rejects invalid values with static errors that omit the private payload", () =>
  provide(
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      const exit = yield* Effect.exit(
        telemetry.recordStart({ ...start, driver: "SECRET /credential" }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude(String(exit), "SECRET");
      assert.equal((yield* sql`SELECT * FROM provider_route_telemetry`).length, 0);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            telemetry.recordEnd(start.runId, {
              endedAt: Number.NaN,
              outcome: "failed",
            }),
          ),
        ),
      );
    }),
  ),
);

it.effect("limits recent observations by age, model, instance, and terminal status", () =>
  provide(
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      for (let index = 0; index < 25; index++) {
        yield* telemetry.recordStart({ ...start, runId: `run-${index}` });
        yield* telemetry.recordEnd(`run-${index}`, { endedAt: 2000 + index, outcome: "completed" });
      }
      yield* telemetry.recordStart({ ...start, runId: "running" });
      yield* telemetry.recordStart({ ...start, runId: "other-model", model: "other" });
      yield* telemetry.recordEnd("other-model", { endedAt: 2100, outcome: "failed" });
      const recent = yield* telemetry.recent(start.instanceId, start.model, 3000);
      assert.equal(recent.length, 20);
      assert.equal(recent[0]?.latencyMs, 1024);
      assert.equal(recent[19]?.latencyMs, 1005);
      assert.deepEqual(yield* telemetry.recent(start.instanceId, start.model, 3602025), []);
      assert.deepEqual(yield* telemetry.recent(start.instanceId, start.model, 1999), []);
    }),
  ),
);

it.effect("retains at most 10000 records", () =>
  provide(
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      // Populate with SQL so the test isolates the database retention bound.
      yield* sql`
      WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 10005)
      INSERT INTO provider_route_telemetry
        (run_hash, thread_hash, driver, instance_hash, model_hash, route_reason, health, started_at)
      SELECT CAST(n AS TEXT), 'hash', 'opencode', 'hash', 'hash', 'local_healthy', 'healthy', n
      FROM entries
    `;
      yield* telemetry.recordStart(start);
      const count = yield* sql<{ readonly count: number; readonly first: number }>`
      SELECT count(*) AS count, MIN(sequence) AS first FROM provider_route_telemetry
    `;
      assert.equal(count[0]?.count, 10000);
      assert.equal(count[0]?.first, 7);
    }),
  ),
);

it.effect("reuses its database salt across close and reopen", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "route-telemetry-"));
  const filename = NodePath.join(directory, "state.sqlite");
  const persistence = () => NodeSqliteClient.layer({ filename });
  return Effect.gen(function* () {
    const first = yield* Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      yield* telemetry.recordStart(start);
      return yield* sql`SELECT * FROM provider_route_telemetry`;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          RouteTelemetry.layer,
          Layer.provideMerge(Layer.effectDiscard(migration), persistence()),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      yield* telemetry.recordStart(start);
      yield* telemetry.recordEnd(start.runId, { endedAt: 2000, outcome: "completed" });
      const rows = yield* sql`SELECT * FROM provider_route_telemetry`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.run_hash, first[0]?.run_hash);
      assert.deepEqual(yield* telemetry.recent(start.instanceId, start.model, 2100), [
        { latencyMs: 1000, outcome: "completed", timeout: false },
      ]);
    }).pipe(Effect.provide(Layer.provideMerge(RouteTelemetry.layer, persistence())));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("records the built-in camelcase claudeAgent driver", () =>
  provide(
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const sql = yield* SqlClient.SqlClient;
      yield* telemetry.recordStart({ ...start, driver: "claudeAgent" });
      yield* telemetry.recordEnd(start.runId, { endedAt: 1600, outcome: "completed" });
      const rows = yield* sql`SELECT driver, outcome FROM provider_route_telemetry`;
      assert.deepEqual([...rows], [{ driver: "claudeAgent", outcome: "completed" }]);
    }),
  ),
);
