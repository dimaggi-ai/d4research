import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import Migration0041 from "./041_ProjectionThreadTurnUsage.ts";
import Migration0042 from "./042_ProjectionThreadResumeSchedule.ts";

const upgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upgradeLayer("043_044_D4UpgradeCompatibility", (it) => {
  it.effect("upgrades databases that used the historical d4 migration slots 37 and 38", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      // d4research shipped these schemas as migrations 37 and 38 before the
      // upstream project assigned those numbers to different migrations.
      yield* Migration0041;
      yield* Migration0042;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (37, 'ProjectionThreadTurnUsage'),
          (38, 'ProjectionThreadResumeSchedule')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [
          [39, "ProjectionProjectsDefaultThreadEnvMode"],
          [40, "ProjectionProjectFaviconPath"],
          [41, "ProjectionThreadTurnUsage"],
          [42, "ProjectionThreadResumeSchedule"],
          [43, "ProjectionThreadsPinOrderKey"],
          [44, "ProjectionTurnsKeysetIndex"],
        ],
      );

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "pin_order_key"));

      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});

const partialUpgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

partialUpgradeLayer("043_044_D4PartialUpgradeCompatibility", (it) => {
  it.effect("finishes the partially upgraded production manifest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (37, 'ProjectionThreadTurnUsage'),
          (38, 'ProjectionThreadResumeSchedule')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [
          [43, "ProjectionThreadsPinOrderKey"],
          [44, "ProjectionTurnsKeysetIndex"],
        ],
      );

      const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 37
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        applied.map((row) => [Number(row.migration_id), row.name]),
        [
          [37, "ProjectionThreadTurnUsage"],
          [38, "ProjectionThreadResumeSchedule"],
          [39, "ProjectionProjectsDefaultThreadEnvMode"],
          [40, "ProjectionProjectFaviconPath"],
          [41, "ProjectionThreadTurnUsage"],
          [42, "ProjectionThreadResumeSchedule"],
          [43, "ProjectionThreadsPinOrderKey"],
          [44, "ProjectionTurnsKeysetIndex"],
        ],
      );
    }),
  );
});

const collisionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

collisionLayer("043_044_D4MigrationCollision", (it) => {
  it.effect("fails closed when a current migration slot has a different recorded name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'DifferentMigration'
        WHERE migration_id = 40
      `;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.match(
          Cause.pretty(exit.cause),
          /Migration slot 40 is recorded as DifferentMigration/,
        );
      }

      const laterMigrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id > 40
      `;
      assert.deepStrictEqual(laterMigrations, []);

      const laterTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'projection_thread_turn_usage',
            'projection_thread_resume_schedule'
          )
      `;
      assert.deepStrictEqual(laterTables, []);

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.notOk(threadColumns.some((column) => column.name === "pin_order_key"));

      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.notOk(
        turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"),
      );
    }),
  );
});
