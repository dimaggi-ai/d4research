import { ThreadId, ThreadTurnUsageRow } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeUsageRows = Schema.decodeUnknownEffect(Schema.Array(ThreadTurnUsageRow));

/** Read usage only, never materialize retained tool payloads for this panel. */
export const getThreadTokenUsage = Effect.fn("getThreadTokenUsage")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT t.provider_turn_id AS "turnId",
      p.provider AS provider,
      json_extract(p.payload_json, '$.providerInstanceId') AS "instanceId",
      json_extract(r.payload_json, '$.modelSelection.model') AS model,
      t.started_at AS "startedAt",
      COALESCE(json_extract(t.payload_json, '$.tokenUsage.updatedAt'), t.completed_at, t.started_at) AS "updatedAt",
      json_extract(t.payload_json, '$.tokenUsage.usedTokens') AS "usedTokens",
      json_extract(t.payload_json, '$.tokenUsage.maxTokens') AS "maxTokens",
      CASE WHEN json_extract(t.payload_json, '$.turnTokenUsage.usageStatus') = 'complete'
        THEN json_extract(t.payload_json, '$.turnTokenUsage.inputTokens') + json_extract(t.payload_json, '$.turnTokenUsage.outputTokens')
        ELSE NULL END AS "totalProcessedTokens",
      COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.inputTokens'), json_extract(t.payload_json, '$.tokenUsage.inputTokens')) AS "inputTokens",
      COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.cachedInputTokens'), json_extract(t.payload_json, '$.tokenUsage.cachedInputTokens')) AS "cachedInputTokens",
      COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.outputTokens'), json_extract(t.payload_json, '$.tokenUsage.outputTokens')) AS "outputTokens",
      COALESCE(json_extract(t.payload_json, '$.turnTokenUsage.reasoningTokens'), json_extract(t.payload_json, '$.tokenUsage.reasoningOutputTokens')) AS "reasoningOutputTokens",
      NULL AS "toolUses", NULL AS "durationMs", NULL AS "totalCostUsd"
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id
    LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
    WHERE t.thread_id = ${threadId} AND p.owner_node_id IS NULL
      AND (json_type(t.payload_json, '$.tokenUsage') = 'object' OR json_type(t.payload_json, '$.turnTokenUsage') = 'object')
    UNION ALL
    SELECT turn_id, provider, instance_id, model, started_at, updated_at, used_tokens,
      max_tokens, total_processed_tokens, input_tokens, cached_input_tokens, output_tokens,
      reasoning_output_tokens, tool_uses, duration_ms, total_cost_usd
    FROM projection_thread_turn_usage WHERE thread_id = ${threadId}
    ORDER BY "startedAt", "updatedAt", "turnId"
  `;
  return yield* decodeUsageRows(rows);
});
