import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

const seedUpstreamPreV2 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 56 });
  yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ('AuthSessionClientConnectionCompat', 'ProjectionProjectWorkspaceRootsCompat', 'ProjectMemories', 'UsageLimitHistory')`;
  const rows = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 45`;
  yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id + 1000 WHERE migration_id >= 45`;
  const ids: Record<string, number> = {
    ProjectionThreadsUnsettledAt: 43,
    ClearAutomaticProjectModelDefaults: 44,
    ProjectionProjectsAutoPull: 45,
    RepairAutomaticSettlementTimestamps: 46,
    ProjectionProjectIcon: 47,
    ProjectionThreadBranchPullRequest: 48,
    ProjectionThreadsActiveOrderKey: 49,
    ProjectionThreadPullRequests: 50,
    ProjectionThreadMessageContext: 51,
    ProjectionThreadTitleState: 52,
  };
  for (const row of rows)
    yield* sql`UPDATE effect_sql_migrations SET migration_id = ${ids[row.name]} WHERE migration_id = ${row.migration_id + 1000}`;
  yield* sql`DROP TABLE project_memories`;
  yield* sql`DROP TABLE usage_limit_history`;
});

// The V2 schema is unchanged from the published September 15–16 previews.
const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedUpstreamPreV2;
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [57, "PullRequestFilesViewed"],
        [58, "ProjectionThreadsAutoSettleDisabledAt"],
        [60, "OrchestrationV2RedundantIndexes"],
        [61, "ForkWorkspaceCompatibility"],
        [62, "ScheduledTaskWebhooks"],
        [63, "WebhookRelayDeliveries"],
        [64, "McpAppModelContext"],
        [65, "ThreadSnapshotWindowIndexes"],
        [66, "PullRequestReviewGuides"],
        [67, "ThreadFailureLookupIndex"],
        [68, "DropUnusedV1Projections"],
        [69, "CanonicalizeThreadPullRequestLinks"],
        [70, "CodexUsageNativeTurnIndex"],
        [71, "RepairClientSettlementTimestamps"],
        [72, "WebhookDedupe"],
        [73, "ShellStopRequestIndex"],
        [74, "ThreadMessageSearch"],
        [75, "PeerLinks"],
        [76, "PeerLinkFence"],
        [77, "WaitingLinkRequestIndex"],
        [78, "ActiveTurnItemIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 59`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUpstreamPreV2;
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [57, "PullRequestFilesViewed"],
        [58, "ProjectionThreadsAutoSettleDisabledAt"],
        [60, "OrchestrationV2RedundantIndexes"],
        [61, "ForkWorkspaceCompatibility"],
        [62, "ScheduledTaskWebhooks"],
        [63, "WebhookRelayDeliveries"],
        [64, "McpAppModelContext"],
        [65, "ThreadSnapshotWindowIndexes"],
        [66, "PullRequestReviewGuides"],
        [67, "ThreadFailureLookupIndex"],
        [68, "DropUnusedV1Projections"],
        [69, "CanonicalizeThreadPullRequestLinks"],
        [70, "CodexUsageNativeTurnIndex"],
        [71, "RepairClientSettlementTimestamps"],
        [72, "WebhookDedupe"],
        [73, "ShellStopRequestIndex"],
        [74, "ThreadMessageSearch"],
        [75, "PeerLinks"],
        [76, "PeerLinkFence"],
        [77, "WaitingLinkRequestIndex"],
        [78, "ActiveTurnItemIndexes"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
