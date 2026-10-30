import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";

it.layer(NodeSqliteClient.layerMemory())("message context upgrade with fork data", (it) => {
  it.effect("preserves fork memories and usage history when adding message context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO project_memories (project_id, name, description, content, updated_at)
        VALUES ('project-1', 'hosts', 'Host locations', 'Internal host notes', '2026-09-13T00:00:00Z')`;
      yield* sql`INSERT INTO usage_limit_history
        (account_id, label, window_id, window_label, bucket, measured_at, remaining_percent)
        VALUES ('personal', 'Personal', 'weekly', 'Weekly', 1, '2026-09-13T00:00:00Z', 75)`;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const notes = yield* sql<{
        readonly content: string;
      }>`SELECT content FROM project_memories WHERE project_id = 'project-1'`;
      const history = yield* sql<{
        readonly remaining_percent: number;
      }>`SELECT remaining_percent FROM usage_limit_history WHERE account_id = 'personal'`;
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.deepEqual(notes, [{ content: "Internal host notes" }]);
      assert.deepEqual(history, [{ remaining_percent: 75 }]);
      assert.isTrue(columns.some((column) => column.name === "context_json"));
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("051_ProjectionThreadMessageContext", (it) => {
  it.effect("accepts context added by an earlier development migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const context = columns.find((column) => column.name === "context_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 55
      `;

      assert.equal(context?.name, "context_json");
      assert.equal(context?.notnull, 0);
      assert.equal(migrations.length, 1);
    }),
  );
});
