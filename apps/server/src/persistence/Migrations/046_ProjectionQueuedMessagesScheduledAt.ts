import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_queued_messages ADD COLUMN scheduled_at TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_queued_messages_scheduled
    ON projection_queued_messages(scheduled_at) WHERE scheduled_at IS NOT NULL
  `;
});
