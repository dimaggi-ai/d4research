import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest as migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import OrchestrationV2 from "./055_OrchestrationV2.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("preserves retired d4 migration slots and appends V2", () =>
    Effect.sync(() => {
      const ids = migrationEntries.map(([id]) => id);
      // 37, 38, 45 and 46 stay reserved for migrations d4research shipped and retired.
      assert.deepStrictEqual(
        ids,
        Array.from({ length: 88 }, (_, index) => index + 1).filter(
          (id) => id !== 37 && id !== 38 && id !== 45 && id !== 46,
        ),
      );
    }),
  );

  it.effect("upgrades released d4 schema 61 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed,
        migrationEntries.filter(([id]) => id > 61).map(([id, name]) => [id, name]),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        migrations.map((row) => [Number(row.migration_id), row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );
});

// Upstream previews recorded V2 at 53. Translate that ledger by name into this
// build's ids instead of letting the id-only migrator skip d4's slots 53-61.
it.effect("translates an upstream V2 preview ledger into this build's ids", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
    });

    const executed = yield* runMigrations();
    assert.deepStrictEqual(
      executed.slice(0, 8).map(([id]) => id),
      [53, 54, 55, 56, 57, 58, 59, 60],
    );
    const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53 AND migration_id <= 62
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      ledger.map((row) => [Number(row.migration_id), row.name]),
      [
        [53, "ProjectionProjectIcon"],
        [54, "ProjectionThreadBranchPullRequest"],
        [55, "ProjectionThreadsActiveOrderKey"],
        [56, "ProjectionThreadPullRequests"],
        [57, "ProjectionThreadMessageContext"],
        [58, "ProjectionThreadTitleState"],
        [59, "PullRequestFilesViewed"],
        [60, "ProjectionThreadComposerModelSelection"],
        [61, "ProjectionThreadsAutoSettleDisabledAt"],
        [62, "OrchestrationV2"],
      ],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("indexes batched Codex native turns without discarding duplicate candidates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 64 });
    for (const [id, driver, nativeId] of [
      ["match", "codex", "requested"],
      ["duplicate", "codex", "requested"],
      ["second", "codex", "requested-second"],
      ["other-provider", "claudeAgent", "requested"],
      ["unrelated", "codex", "unrelated"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: `attempt-${id}`,
        thread_id: `thread-${id}`,
        run_id: `run-${id}`,
        attempt_ordinal: 1,
        root_node_id: `node-${id}`,
        provider: driver,
        provider_thread_id: `provider-thread-${id}`,
        status: "completed",
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
        provider_turn_id: `turn-${id}`,
        thread_id: `thread-${id}`,
        provider_thread_id: `provider-thread-${id}`,
        node_id: `node-${id}`,
        run_attempt_id: `attempt-${id}`,
        ordinal: 1,
        status: "completed",
        payload_json: encodeJson({ nativeTurnRef: { driver, nativeId, strength: "strong" } }),
      })}`;
    }
    const lookup = sql<{ readonly provider_turn_id: string }>`
      SELECT turn.provider_turn_id
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${encodeJson(["requested", "requested-second", "missing"])})
        )
    `;
    const before = (yield* lookup).map((row) => row.provider_turn_id).toSorted();
    assert.deepStrictEqual(before, ["turn-duplicate", "turn-match", "turn-second"]);
    yield* runMigrations();
    assert.deepStrictEqual((yield* lookup).map((row) => row.provider_turn_id).toSorted(), before);

    const [statement, parameters] = lookup.compile();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
      parameters,
    );
    assert.isTrue(
      plan.some(({ detail }) =>
        /SEARCH turn USING INDEX orchestration_v2_provider_turns_codex_native_id_idx\b/.test(
          detail,
        ),
      ),
      plan.map(({ detail }) => detail).join("\n"),
    );
    assert.isFalse(plan.some(({ detail }) => /SCAN turn\b/.test(detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
