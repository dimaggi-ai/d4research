import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_monitor_device_claims (
    thread_id TEXT NOT NULL,
    report_key TEXT NOT NULL,
    client_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, report_key, client_id)
  )`;
  yield* sql`CREATE TABLE agent_monitor_control (
    id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
    baseline_sequence INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO agent_monitor_control(id) VALUES (1)`;
  yield* sql`CREATE TABLE agent_monitor_observations (
    thread_id TEXT PRIMARY KEY,
    report_key TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    baseline INTEGER NOT NULL,
    eligible_at INTEGER
  )`;
});
