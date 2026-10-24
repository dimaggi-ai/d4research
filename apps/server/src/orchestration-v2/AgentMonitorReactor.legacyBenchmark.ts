import { ThreadId } from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Retains the previous evidence query and transaction pattern for an apples-to-apples
// synthetic baseline. Excludes its decoding/writes, so this is a conservative cost.
export const measureLegacyMonitorSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const observe = (now: number, threadId?: ThreadId, enabled = true) => sql<{ thread_id: string }>`
    SELECT t.thread_id,
      COALESCE((SELECT MAX(sequence) FROM orchestration_events e
        WHERE e.stream_id = t.thread_id AND e.aggregate_kind = 'thread'
        AND e.application_event_version = 2), 0) AS sequence,
      r.run_id, r.status AS run_status,
      json_extract(r.payload_json, '$.activeAttemptId') AS attempt_id,
      COALESCE(q.runtime_request_id, secret.turn_item_id) AS request_id,
      CASE WHEN q.runtime_request_id IS NOT NULL THEN q.kind
        WHEN secret.turn_item_id IS NOT NULL THEN 'user_input' ELSE NULL END AS request_kind,
      s.status AS session_status,
      COALESCE((SELECT MAX(i.updated_at) FROM orchestration_v2_projection_turn_items i
        WHERE i.run_id = r.run_id AND i.provider_turn_id = a.provider_turn_id),
        json_extract(a.payload_json, '$.startedAt'), json_extract(r.payload_json, '$.startedAt'), r.requested_at) AS progress_at,
      (SELECT json_extract(i.payload_json, '$.failure.class')
        FROM orchestration_v2_projection_turn_items i WHERE i.run_id = r.run_id
        AND i.type = 'error' AND i.status = 'failed'
        AND i.provider_turn_id = a.provider_turn_id
        AND i.node_id = json_extract(r.payload_json, '$.rootNodeId')
        ORDER BY i.updated_at DESC, i.ordinal DESC LIMIT 1) AS failure_class,
      (COALESCE(json_array_length(p.payload_json, '$.pendingBackgroundTasks'), 0)
        + EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs owner ON owner.run_id = item.run_id
          WHERE item.thread_id = t.thread_id AND item.type IN ('command_execution','dynamic_tool','subagent')
          AND item.status IN ('pending','running','waiting') AND COALESCE(owner.status, '') != 'rolled_back'
          AND NOT(item.type = 'dynamic_tool' AND COALESCE(json_extract(item.payload_json, '$.input.persistent'), 0) = 1))
        + EXISTS(SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
          WHERE json_type(link.value, '$.watch') = 'object'
          AND COALESCE(json_extract(link.value, '$.source'), '') != 'stack-dismissed')) AS background_count,
      EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox o WHERE o.thread_id = t.thread_id
        AND o.status = 'running' AND o.lease_expires_at < ${DateTime.formatIso(DateTime.makeUnsafe(now))}) AS lease_expired,
      json_extract(t.payload_json, '$.agentMonitor') AS report_json,
      COALESCE(json_extract(t.payload_json, '$.agentMonitorRevision'), 0) AS revision
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
      SELECT candidate.run_id FROM orchestration_v2_projection_runs candidate
      WHERE candidate.thread_id = t.thread_id
      ORDER BY CASE WHEN candidate.status IN ('preparing','starting','running','waiting') THEN 0 ELSE 1 END,
        candidate.ordinal DESC LIMIT 1)
    LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = json_extract(r.payload_json, '$.activeAttemptId')
    LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = COALESCE(a.provider_thread_id, r.provider_thread_id)
    LEFT JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = p.provider_session_id
    LEFT JOIN orchestration_v2_projection_runtime_requests q ON q.runtime_request_id = (
      SELECT request.runtime_request_id FROM orchestration_v2_projection_runtime_requests request
      JOIN orchestration_v2_projection_nodes node ON node.node_id = request.node_id
      WHERE request.thread_id = t.thread_id AND request.status = 'pending' AND node.run_id = r.run_id
        AND r.status IN ('preparing','starting','running','waiting')
        AND (request.provider_turn_id IS NULL OR request.provider_turn_id = a.provider_turn_id)
      ORDER BY request.created_at DESC, request.runtime_request_id DESC LIMIT 1)
    LEFT JOIN orchestration_v2_projection_turn_items secret ON secret.turn_item_id = (
      SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
      WHERE item.thread_id = t.thread_id AND item.run_id = r.run_id
        AND r.status IN ('preparing','starting','running','waiting')
        AND item.type = 'secret_request' AND item.status = 'waiting'
        AND (item.provider_turn_id IS NULL OR item.provider_turn_id = a.provider_turn_id)
      ORDER BY item.updated_at DESC, item.ordinal DESC LIMIT 1)
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
      AND (${enabled} OR json_extract(t.payload_json, '$.agentMonitor') IS NOT NULL)
      AND (${threadId ?? null} IS NULL OR t.thread_id = ${threadId ?? null})
  `;

  const started = performance.now();
  const rows = yield* observe(now);
  for (const row of rows) yield* sql.withTransaction(observe(now, ThreadId.make(row.thread_id)));
  return performance.now() - started;
});
