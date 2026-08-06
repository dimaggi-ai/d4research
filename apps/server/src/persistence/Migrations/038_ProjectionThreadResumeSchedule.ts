import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_resume_schedule (
      thread_id TEXT PRIMARY KEY,
      resume_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      provider TEXT,
      instance_id TEXT,
      model TEXT,
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_resume_schedule_resume_at
    ON projection_thread_resume_schedule(resume_at)
  `;
});
