import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_route_telemetry_salt (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      salt TEXT NOT NULL
    )
  `;
  yield* sql`INSERT INTO provider_route_telemetry_salt VALUES (1, lower(hex(randomblob(32))))`;
  yield* sql`
    CREATE TABLE provider_route_telemetry (
      sequence INTEGER PRIMARY KEY,
      run_hash TEXT NOT NULL UNIQUE,
      thread_hash TEXT NOT NULL,
      driver TEXT NOT NULL,
      instance_hash TEXT NOT NULL,
      model_hash TEXT NOT NULL,
      route_reason TEXT NOT NULL,
      health TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      context_tokens INTEGER,
      outcome TEXT NOT NULL DEFAULT 'running',
      timeout INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      fallbacks INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX provider_route_telemetry_recent
    ON provider_route_telemetry(instance_hash, model_hash, ended_at DESC)
    WHERE outcome != 'running'
  `;
  yield* sql`
    CREATE TRIGGER provider_route_telemetry_retention AFTER INSERT ON provider_route_telemetry
    BEGIN
      DELETE FROM provider_route_telemetry
      WHERE sequence <= NEW.sequence - 10000;
    END
  `;
});
