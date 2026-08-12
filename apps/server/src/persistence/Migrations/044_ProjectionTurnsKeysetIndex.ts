import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Composite index for windowed thread detail reads. This intentionally uses
 * migration slot 44: older d4research databases already assigned slot 37 to
 * ProjectionThreadTurnUsage, before the upstream keyset migration existed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
});
