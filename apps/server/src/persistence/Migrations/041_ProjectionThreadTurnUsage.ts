import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_turn_usage (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider TEXT,
      instance_id TEXT,
      model TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      used_tokens INTEGER,
      max_tokens INTEGER,
      total_processed_tokens INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      tool_uses INTEGER,
      duration_ms INTEGER,
      total_cost_usd REAL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_turn_usage_thread_id
    ON projection_thread_turn_usage(thread_id)
  `;
});
