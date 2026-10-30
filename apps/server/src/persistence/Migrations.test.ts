import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 59);
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
  it.effect("adds pending migrations to released fork databases without replacing fork data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* sql`INSERT INTO project_memories (project_id, name, description, content, updated_at)
        VALUES ('project', 'guide', 'Private guide', 'Keep fork behavior', '2026-10-20T00:00:00Z')`;
      yield* sql`INSERT INTO usage_limit_history
        (account_id, label, color, window_id, window_label, bucket, measured_at, remaining_percent, resets_at)
        VALUES ('work', 'Work account', '#123456', 'weekly', 'Weekly', 1, '2026-10-20T00:00:00Z', 25, NULL)`;
      const beforeHistory = yield* history;
      const memories = yield* sql`SELECT * FROM project_memories`;
      const usage = yield* sql`SELECT * FROM usage_limit_history`;

      assert.deepStrictEqual(yield* runMigrations(), [
        [72, "WebhookDedupe"],
        [73, "ShellStopRequestIndex"],
        [74, "ThreadMessageSearch"],
        [75, "PeerLinks"],
        [76, "PeerLinkFence"],
        [77, "WaitingLinkRequestIndex"],
        [78, "ActiveTurnItemIndexes"],
      ]);
      assert.deepStrictEqual(yield* history, [
        ...beforeHistory,
        [72, "WebhookDedupe"],
        [73, "ShellStopRequestIndex"],
        [74, "ThreadMessageSearch"],
        [75, "PeerLinks"],
        [76, "PeerLinkFence"],
        [77, "WaitingLinkRequestIndex"],
        [78, "ActiveTurnItemIndexes"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM project_memories`, memories);
      assert.deepStrictEqual(yield* sql`SELECT * FROM usage_limit_history`, usage);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

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
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 58 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "59_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
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

  it.effect("upgrades a database at exactly 58", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 58 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 58])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (60, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 59 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 60 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "60_OrchestrationV2RedundantIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "62_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
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

// Fork migration ids differ from upstream filenames; released ids must stay registered as-is.
it.effect("imports every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = (yield* fs.readDirectory(path.join(import.meta.dirname, "Migrations"))).filter(
      (name) => /^\d+_\w+\.ts$/.test(name),
    );
    const source = yield* fs.readFileString(path.join(import.meta.dirname, "Migrations.ts"));
    const imported = new Set(
      [...source.matchAll(/from "\.\/Migrations\/(\d+_\w+\.ts)"/g)].map((match) => match[1]),
    );
    assert.deepStrictEqual([...imported].sort(), files.sort());
    // Keep the release launcher's source reader aligned with the executed registry.
    const registered = [...source.matchAll(/^\s*\[(\d+), "(\w+)", Migration\w+\],/gm)].map(
      (match) => [Number(match[1]), match[2]!] as const,
    );
    assert.deepStrictEqual(registered, migrationManifest);
  }).pipe(Effect.provide(NodeServices.layer)),
);
