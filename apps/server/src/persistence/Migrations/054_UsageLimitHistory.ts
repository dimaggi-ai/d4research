import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_limit_history (
    account_id TEXT NOT NULL,
    label TEXT NOT NULL,
    color TEXT,
    window_id TEXT NOT NULL,
    window_label TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    measured_at TEXT NOT NULL,
    remaining_percent REAL NOT NULL,
    resets_at TEXT,
    PRIMARY KEY (account_id, window_id, bucket)
  )`;
  yield* sql`CREATE INDEX usage_limit_history_time ON usage_limit_history(bucket)`;
});
