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

upgradeLayer("043_051_D4UpgradeCompatibility", (it) => {
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
          [47, "AuthSessionClientConnection"],
          [48, "ProjectionThreadLinkedPullRequest"],
          [49, "ProjectionThreadsUnsettledAt"],
          [50, "ClearAutomaticProjectModelDefaults"],
          [51, "ProjectionProjectsAutoPull"],
          [52, "RepairAutomaticSettlementTimestamps"],
          [53, "ProjectionProjectIcon"],
          [54, "ProjectionThreadBranchPullRequest"],
          [55, "ProjectionThreadsActiveOrderKey"],
        ],
      );

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "pin_order_key"));
      assert.ok(threadColumns.some((column) => column.name === "unsettled_at"));
      assert.ok(threadColumns.some((column) => column.name === "linked_pull_request_json"));

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(projectColumns.some((column) => column.name === "auto_pull"));
      assert.ok(projectColumns.some((column) => column.name === "project_icon_json"));

      const turnIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(turnIndexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});

const partialUpgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

partialUpgradeLayer("043_051_D4PartialUpgradeCompatibility", (it) => {
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
          [47, "AuthSessionClientConnection"],
          [48, "ProjectionThreadLinkedPullRequest"],
          [49, "ProjectionThreadsUnsettledAt"],
          [50, "ClearAutomaticProjectModelDefaults"],
          [51, "ProjectionProjectsAutoPull"],
          [52, "RepairAutomaticSettlementTimestamps"],
          [53, "ProjectionProjectIcon"],
          [54, "ProjectionThreadBranchPullRequest"],
          [55, "ProjectionThreadsActiveOrderKey"],
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
          [47, "AuthSessionClientConnection"],
          [48, "ProjectionThreadLinkedPullRequest"],
          [49, "ProjectionThreadsUnsettledAt"],
          [50, "ClearAutomaticProjectModelDefaults"],
          [51, "ProjectionProjectsAutoPull"],
          [52, "RepairAutomaticSettlementTimestamps"],
          [53, "ProjectionProjectIcon"],
          [54, "ProjectionThreadBranchPullRequest"],
          [55, "ProjectionThreadsActiveOrderKey"],
        ],
      );
    }),
  );
});

const collisionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const queuedHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

queuedHistoryLayer("D4QueuedMessageUpgradeCompatibility", (it) => {
  it.effect("preserves shipped queue slots and data while adding the current schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`
        CREATE TABLE projection_queued_messages (
          message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL,
          attachments_json TEXT NOT NULL, model_selection_json TEXT,
          source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT,
          queued_at TEXT NOT NULL, scheduled_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO projection_queued_messages
          (message_id, thread_id, text, attachments_json, queued_at, scheduled_at)
        VALUES ('queued-1', 'thread-1', 'Keep this queued message', '[]',
          '2026-08-27T15:29:12Z', '2026-09-05T12:00:00Z')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (45, 'ProjectionQueuedMessages'), (46, 'ProjectionQueuedMessagesScheduledAt')
      `;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [47, 48, 49, 50, 51, 52, 53, 54, 55],
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
      assert.ok(columns.some((column) => column.name === "auto_pull"));
      assert.ok(columns.some((column) => column.name === "project_icon_json"));
      const queued = yield* sql<{ readonly text: string; readonly scheduled_at: string }>`
        SELECT text, scheduled_at FROM projection_queued_messages WHERE message_id = 'queued-1'
      `;
      assert.deepStrictEqual(queued, [
        {
          text: "Keep this queued message",
          scheduled_at: "2026-09-05T12:00:00Z",
        },
      ]);
      const history = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id IN (45, 46) ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => row.name),
        ["ProjectionQueuedMessages", "ProjectionQueuedMessagesScheduledAt"],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

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
