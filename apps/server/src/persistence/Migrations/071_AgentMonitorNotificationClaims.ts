import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_monitor_notification_claims (
    thread_id TEXT NOT NULL,
    report_key TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, report_key)
  )`;
});
