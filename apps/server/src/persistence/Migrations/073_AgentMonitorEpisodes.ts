import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_monitor_observations ADD COLUMN evidence_key TEXT`;
  yield* sql`ALTER TABLE agent_monitor_observations ADD COLUMN episode_started_at INTEGER`;
  yield* sql`UPDATE agent_monitor_observations SET episode_started_at = first_seen_at`;
  yield* sql`CREATE INDEX agent_monitor_claims_age ON agent_monitor_device_claims(claimed_at)`;
  yield* sql`CREATE INDEX agent_monitor_progress ON orchestration_v2_projection_turn_items(run_id, provider_turn_id, updated_at DESC)`;
});
