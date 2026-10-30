import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import ProjectionTurnsKeysetIndex from "./Migrations/044_ProjectionTurnsKeysetIndex.ts";
import ProjectionThreadsPinOrderKey from "./Migrations/043_ProjectionThreadsPinOrderKey.ts";
import ProjectionProjectWorkspaceRoots from "./Migrations/041_ProjectionProjectWorkspaceRoots.ts";
import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import ProjectMemories from "./Migrations/052_ProjectMemories.ts";
import UsageLimitHistory from "./Migrations/054_UsageLimitHistory.ts";

const memoryLayer = () =>
  it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const byName = new Map(migrationEntries.map(([, name, migration]) => [name, migration]));

// The pilshchikov fork's released ledger from slot 37 onward, in its own order.
type MigrationEffect = (typeof migrationEntries)[number][2];

const FORK_LEDGER: ReadonlyArray<readonly [number, string, ReadonlyArray<MigrationEffect>]> = [
  [37, "ProjectionTurnsKeysetIndex", [ProjectionTurnsKeysetIndex]],
  [38, "ProjectionThreadsPinOrderKey", [ProjectionThreadsPinOrderKey]],
  [
    39,
    "ProjectionProjectsDefaultThreadEnvMode",
    [byName.get("ProjectionProjectsDefaultThreadEnvMode")!],
  ],
  [40, "ProjectionProjectFaviconPath", [byName.get("ProjectionProjectFaviconPath")!]],
  [
    41,
    "ProjectionProjectWorkspaceRoots",
    [ProjectionProjectWorkspaceRoots, AuthSessionClientConnection],
  ],
  [42, "ProjectionThreadLinkedPullRequest", [byName.get("ProjectionThreadLinkedPullRequest")!]],
  [43, "AuthSessionClientConnectionCompat", []],
  [44, "ProjectionProjectWorkspaceRootsCompat", []],
  [45, "ProjectionThreadsUnsettledAt", [byName.get("ProjectionThreadsUnsettledAt")!]],
  [46, "ClearAutomaticProjectModelDefaults", [byName.get("ClearAutomaticProjectModelDefaults")!]],
  [47, "ProjectionProjectsAutoPull", [byName.get("ProjectionProjectsAutoPull")!]],
  [48, "RepairAutomaticSettlementTimestamps", [byName.get("RepairAutomaticSettlementTimestamps")!]],
  [49, "ProjectionProjectIcon", [byName.get("ProjectionProjectIcon")!]],
  [50, "ProjectionThreadBranchPullRequest", [byName.get("ProjectionThreadBranchPullRequest")!]],
  [51, "ProjectionThreadsActiveOrderKey", [byName.get("ProjectionThreadsActiveOrderKey")!]],
  [52, "ProjectMemories", [ProjectMemories]],
  [53, "ProjectionThreadPullRequests", [byName.get("ProjectionThreadPullRequests")!]],
  [54, "UsageLimitHistory", [UsageLimitHistory]],
  [55, "ProjectionThreadMessageContext", [byName.get("ProjectionThreadMessageContext")!]],
  [56, "ProjectionThreadTitleState", [byName.get("ProjectionThreadTitleState")!]],
  [57, "PullRequestFilesViewed", [byName.get("PullRequestFilesViewed")!]],
  [
    58,
    "ProjectionThreadsAutoSettleDisabledAt",
    [byName.get("ProjectionThreadsAutoSettleDisabledAt")!],
  ],
  [59, "OrchestrationV2", [byName.get("OrchestrationV2")!]],
  [60, "OrchestrationV2RedundantIndexes", [byName.get("RemoveRedundantProjectionIndexes")!]],
  [61, "ForkWorkspaceCompatibility", []],
  [62, "ScheduledTaskWebhooks", [byName.get("ScheduledTaskWebhooks")!]],
];

const writeForkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 36 });
  for (const [id, name, migrations] of FORK_LEDGER) {
    for (const migration of migrations) yield* migration;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
});

memoryLayer()("reconcileForkMigrationHistory fork ledger", (it) => {
  it.effect("translates a fork database into this ledger and runs only what it lacked", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* writeForkHistory;

      const executed = yield* runMigrations();
      const executedNames = executed.map(([, name]) => name);
      // d4research-only migrations below the fork's newest translated id run during translation.
      assert.includeMembers(executedNames, [
        "ProjectionThreadTurnUsage",
        "ProjectionThreadResumeSchedule",
        "ProjectionThreadComposerModelSelection",
      ]);
      assert.notInclude(executedNames, "OrchestrationV2");
      assert.notInclude(executedNames, "ProjectMemories");

      const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const expected = migrationEntries.map(([id, name]) => [id, name]);
      assert.deepStrictEqual(
        ledger.map((row) => [Number(row.migration_id), row.name]),
        expected,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

memoryLayer()("reconcileForkMigrationHistory unknown ledger", (it) => {
  it.effect("refuses a migration name this build does not know before changing schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'SomeFutureMigration')`;
      const before = yield* sql`SELECT name FROM sqlite_master ORDER BY name`;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(String(exit.cause), "SomeFutureMigration");
      }
      assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master ORDER BY name`, before);
    }),
  );
});

memoryLayer()("reconcileForkMigrationHistory fresh database", (it) => {
  it.effect("creates the full ledger on an empty database", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationEntries.map(([id]) => id),
      );
    }),
  );
});

// Snapshot of a released d4research database (ledger through 70), copied by the caller.
const snapshotPath = process.env.D4_MIGRATION_SNAPSHOT;
if (snapshotPath !== undefined) {
  it.layer(NodeSqliteClient.layer({ filename: snapshotPath }))(
    "reconcileForkMigrationHistory released d4research snapshot",
    (it) => {
      it.effect("upgrades a released d4research database without translation", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const before = yield* sql<{ readonly migration_id: number }>`
            SELECT max(migration_id) AS migration_id FROM effect_sql_migrations
          `;
          const executed = yield* runMigrations();
          assert.deepStrictEqual(
            executed.map(([id]) => id),
            migrationEntries.map(([id]) => id).filter((id) => id > Number(before[0]!.migration_id)),
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
        }),
      );
    },
  );
}
