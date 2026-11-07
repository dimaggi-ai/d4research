import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 62);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 61 }))),
      );
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "Migration slot 62 is recorded as FutureMainMigration, but this build expects OrchestrationV2",
      );
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 61", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 61 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 61])("rejects a reused d4 migration slot at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      const before = yield* history;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), `Migration slot ${id} is recorded as SiteLocalMigration`);
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects conflicting migration names even beyond the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (63, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 62 }))),
      );
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 63 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "Migration slot 63 is recorded as SiteLocalMigration, but this build expects RemoveRedundantProjectionIndexes",
      );
      assert.notInclude(String(exit), "64_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades the preserved d4 ledger through the appended upstream migrations", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 65 });
      assert.deepStrictEqual(yield* runMigrations(), [
        [66, "McpAppModelContext"],
        [67, "ThreadSnapshotWindowIndexes"],
        [68, "PullRequestReviewGuides"],
        [69, "ThreadFailureLookupIndex"],
        [70, "DropUnusedV1Projections"],
        [71, "AgentMonitorNotificationClaims"],
        [72, "AgentMonitorDelivery"],
        [73, "AgentMonitorEpisodes"],
        [74, "RouteTelemetry"],
        [75, "ScheduledTaskRunCorrelation"],
        [76, "ProjectionProjectWorkspaceRoots"],
        [77, "ProjectMemories"],
        [78, "UsageLimitHistory"],
        [79, "CanonicalizeThreadPullRequestLinks"],
        [80, "CodexUsageNativeTurnIndex"],
        [81, "RepairClientSettlementTimestamps"],
        [82, "WebhookDedupe"],
        [83, "ShellStopRequestIndex"],
        [84, "ThreadMessageSearch"],
        [85, "PeerLinks"],
        [86, "PeerLinkFence"],
        [87, "WaitingLinkRequestIndex"],
        [88, "ActiveTurnItemIndexes"],
        [89, "ExcludeAttachmentPlaceholdersFromSearch"],
        [90, "SubagentDeliveryState"],
        [91, "ProjectionProjectsPinArchive"],
        [92, "RepairBooleanSettledOverride"],
        [93, "DropOrchestrationEventCorrelationIndex"],
        [94, "DelegatedRecoveryIndexes"],
        [95, "ScheduledTaskThreadMode"],
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
