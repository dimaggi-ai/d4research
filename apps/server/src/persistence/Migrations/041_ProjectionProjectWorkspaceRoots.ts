import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "workspace_roots_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_roots_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  // Older rows have the primary root available in workspace_root. Backfill
  // the new list so every projected project is immediately multi-root aware.
  yield* sql`
    UPDATE projection_projects
    SET workspace_roots_json = json_array(json_object('path', workspace_root))
    WHERE workspace_roots_json IS NULL OR workspace_roots_json = '[]'
  `;
});
