import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_message_id TEXT`;
  yield* sql`
    CREATE TABLE scheduled_task_runs (
      message_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`CREATE INDEX scheduled_task_runs_pending ON scheduled_task_runs(status) WHERE status = 'running'`;
  yield* sql`CREATE INDEX scheduled_task_runs_completed ON scheduled_task_runs(completed_at)`;
});
