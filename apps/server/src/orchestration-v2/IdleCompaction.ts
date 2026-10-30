import {
  ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  ThreadId,
} from "@d4research/contracts";
import { resolveProjectSettings } from "@d4research/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";

export class IdleCompactionError extends Schema.TaggedError<IdleCompactionError>()(
  "IdleCompactionError",
  { cause: Schema.Defect() },
) {}

export class IdleCompaction extends Context.Service<
  IdleCompaction,
  {
    readonly due: (
      threadId?: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
      IdleCompactionError
    >;
  }
>()("t3/orchestration-v2/IdleCompaction") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = Effect.fn("IdleCompaction.due")(
    function* (threadId?: ThreadId) {
      const preferences = yield* settings.getSettings;
      if (
        !preferences.idleCompactionEnabled &&
        !Object.values(preferences.projectSettingsOverrides).some(
          (override) => override.idleCompactionEnabled === true,
        )
      )
        return [];
      const policies = [
        preferences,
        ...Object.keys(preferences.projectSettingsOverrides).map(
          (projectId) => resolveProjectSettings(preferences, ProjectId.make(projectId)).settings,
        ),
      ].filter((policy) => policy.idleCompactionEnabled);
      const minTokens = Math.min(...policies.map((policy) => policy.idleCompactionTokens));
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const cutoff = DateTime.formatIso(
        DateTime.makeUnsafe(
          now - Math.min(...policies.map((policy) => policy.idleCompactionMinutes)) * 60_000,
        ),
      );
      // Read only summaries, never transcripts. Classify pending work as 0 (none),
      // 1 (native work that survives compaction), or 2 (must finish first).
      // A completed root turn is required even when native background work is allowed.
      const rows = yield* sql<{
        thread_id: string;
        project_id: string;
        provider_instance_id: string;
        run_id: string;
        used_tokens: number;
        idle_since: string;
        completed_at: string;
        result_received_at: string | null;
        provider_status: string;
        roster_work: number;
        item_work: number;
        subagent_work: number;
      }>`
      SELECT t.thread_id, t.project_id, t.provider_instance_id, r.run_id, r.completed_at, p.status AS provider_status,
        (SELECT max(reply.updated_at)
          FROM orchestration_v2_projection_turn_items reply
          JOIN orchestration_v2_projection_provider_turns reply_turn
            ON reply_turn.provider_turn_id = reply.provider_turn_id
            AND reply_turn.status = 'completed'
          JOIN orchestration_v2_projection_run_attempts reply_attempt
            ON reply_attempt.attempt_id = reply_turn.run_attempt_id
            AND reply_attempt.run_id = r.run_id
            AND reply_attempt.root_node_id = reply_turn.node_id
          WHERE reply.thread_id = t.thread_id AND reply.run_id = r.run_id
            AND reply.type = 'assistant_message' AND reply.status = 'completed'
            AND reply_turn.provider_thread_id = p.provider_thread_id) AS result_received_at,
        COALESCE((SELECT max(CASE
          WHEN background.provider_thread_id = p.provider_thread_id
            AND json_extract(task.value, '$.kind') IN ('command', 'monitor', 'subagent')
          THEN 1 ELSE 2 END)
          FROM orchestration_v2_projection_provider_threads background,
            json_each(background.payload_json, '$.pendingBackgroundTasks') task
          WHERE background.thread_id = t.thread_id), 0) AS roster_work,
        COALESCE((SELECT max(CASE
          WHEN item.type = 'subagent'
            AND json_extract(item.payload_json, '$.origin') = 'provider_native'
            AND json_extract(item.payload_json, '$.driver') = p.driver
            AND json_extract(item.payload_json, '$.providerInstanceId') = p.provider_instance_id
          THEN 1
          WHEN (item.type = 'command_execution' OR (p.driver = 'claudeAgent'
            AND item.type = 'dynamic_tool' AND json_extract(item.payload_json, '$.toolName') = 'Monitor'))
            AND (item.provider_thread_id = p.provider_thread_id OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents native_child
              WHERE native_child.thread_id = t.thread_id
                AND native_child.provider_thread_id = item.provider_thread_id
                AND native_child.origin = 'provider_native'
                AND native_child.driver = p.driver
                AND native_child.provider_instance_id = p.provider_instance_id))
          THEN 1 ELSE 2 END)
          FROM orchestration_v2_projection_turn_items item
          WHERE item.thread_id = t.thread_id AND item.status IN ('pending', 'running', 'waiting')
            AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs abandoned
              WHERE abandoned.run_id = item.run_id AND abandoned.status = 'rolled_back')), 0) AS item_work,
        COALESCE((SELECT max(CASE
          WHEN child.origin = 'provider_native' AND child.driver = p.driver
            AND child.provider_instance_id = p.provider_instance_id
          THEN 1 ELSE 2 END)
          FROM orchestration_v2_projection_subagents child
          WHERE child.thread_id = t.thread_id AND child.status IN ('pending', 'running', 'waiting')), 0)
          AS subagent_work,
        -- Live usage is recorded on provider turns. The thread snapshot is
        -- carried across handoffs and can predate many subsequent turns.
        COALESCE((SELECT json_extract(turn.payload_json, '$.tokenUsage.usedTokens')
          FROM orchestration_v2_projection_provider_turns turn
          JOIN orchestration_v2_projection_run_attempts attempt
            ON attempt.attempt_id = turn.run_attempt_id
            AND attempt.provider_thread_id = p.provider_thread_id
            AND attempt.root_node_id = turn.node_id
            AND json_extract(attempt.payload_json, '$.nativeThreadId') =
              json_extract(p.payload_json, '$.nativeThreadRef.nativeId')
          WHERE turn.provider_thread_id = p.provider_thread_id
            AND turn.thread_id = t.thread_id
            AND json_extract(turn.payload_json, '$.tokenUsage.usedTokens') IS NOT NULL
          ORDER BY json_extract(turn.payload_json, '$.tokenUsage.updatedAt') DESC,
            turn.ordinal DESC LIMIT 1),
          json_extract(p.payload_json, '$.contextUsage.usedTokens')) AS used_tokens,
        max(r.completed_at, p.updated_at,
          COALESCE((SELECT max(provider.updated_at) FROM orchestration_v2_projection_provider_threads provider
            WHERE provider.thread_id = t.thread_id), r.completed_at),
          COALESCE((SELECT max(i.updated_at) FROM orchestration_v2_projection_turn_items i
            WHERE i.thread_id = t.thread_id), r.completed_at),
          COALESCE((SELECT max(s.updated_at) FROM orchestration_v2_projection_subagents s
            WHERE s.thread_id = t.thread_id), r.completed_at)) AS idle_since
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads p
        ON p.provider_thread_id = t.active_provider_thread_id
        AND p.provider_instance_id = t.provider_instance_id
      JOIN orchestration_v2_projection_runs r ON r.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = t.thread_id AND latest.status <> 'queued'
          AND NOT (latest.status = 'cancelled' AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
        ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
          latest.ordinal DESC LIMIT 1
      ) AND r.status = 'completed'
      JOIN orchestration_v2_projection_messages m
        ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
      WHERE (${threadId ?? null} IS NULL OR t.thread_id = ${threadId ?? null})
        AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
        AND json_extract(t.payload_json, '$.settledAt') IS NULL
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers transfer
          WHERE transfer.target_thread_id = t.thread_id AND transfer.type = 'merge_back' AND transfer.status = 'pending')
        AND json_extract(t.payload_json, '$.snoozedUntil') IS NULL
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND p.driver IN ('claudeAgent', 'codex')
        AND p.status IN ('idle', 'not_loaded')
        AND r.completed_at <= ${cutoff}
        AND used_tokens >= ${minTokens}
        AND lower(trim(json_extract(m.payload_json, '$.text'))) <> '/compact'
        AND lower(trim(json_extract(m.payload_json, '$.text'))) NOT LIKE '/compact %'
        -- A reset clock or a synthetic completed run cannot clear a quota block.
        -- Require a different successful root turn, on the active provider, with
        -- real results after the failure and its reported reset time (if known).
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items limited
          JOIN orchestration_v2_projection_runs limited_run ON limited_run.run_id = limited.run_id
          WHERE limited.thread_id = t.thread_id AND limited.type = 'error'
            AND json_extract(limited.payload_json, '$.failure.class') = 'usage_limit'
            AND limited.node_id IS json_extract(limited_run.payload_json, '$.rootNodeId')
            AND limited_run.provider = p.driver
            AND COALESCE(limited_run.provider_instance_id,
              json_extract(limited_run.payload_json, '$.providerInstanceId'),
              json_extract(limited_run.payload_json, '$.modelSelection.instanceId'),
              p.provider_instance_id) = p.provider_instance_id
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_provider_turns recovered
              JOIN orchestration_v2_projection_run_attempts recovered_attempt
                ON recovered_attempt.attempt_id = recovered.run_attempt_id
                AND recovered_attempt.root_node_id = recovered.node_id
                AND recovered_attempt.run_id = r.run_id
              WHERE recovered.thread_id = t.thread_id
                AND recovered.provider_thread_id = p.provider_thread_id
                AND recovered.status = 'completed'
                AND r.run_id <> limited.run_id
                AND recovered.completed_at > limited.updated_at
                AND (json_extract(limited.payload_json, '$.failure.resetAt') IS NULL
                  OR julianday(recovered.completed_at) >=
                    julianday(json_extract(limited.payload_json, '$.failure.resetAt')))
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_turn_items result
                  WHERE result.thread_id = t.thread_id AND result.run_id = r.run_id
                    AND result.provider_turn_id = recovered.provider_turn_id
                    AND result.status = 'completed'
                    AND result.type IN ('assistant_message', 'command_execution', 'dynamic_tool')
                    AND result.updated_at > limited.updated_at
                )
            )
        )
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs busy
          WHERE busy.thread_id = t.thread_id
          AND busy.status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = t.thread_id AND request.status = 'pending')
      ORDER BY t.thread_id
    `;
      return rows.flatMap((row) => {
        const policy = resolveProjectSettings(preferences, ProjectId.make(row.project_id)).settings;
        const work = Math.max(row.roster_work, row.item_work, row.subagent_work);
        const allowBackground = policy.idleCompactionAllowBackgroundWork;
        // Never resume an unloaded process hoping its background work survived.
        if (work > (allowBackground && row.provider_status === "idle" ? 1 : 0)) return [];
        // Background output does not keep postponing compaction. A new parent
        // reply/continuation does: it creates a new run and restarts this timeout.
        const resultReceivedAt =
          row.result_received_at === null ? 0 : Date.parse(row.result_received_at);
        const idleSince = Math.max(
          Date.parse(allowBackground ? row.completed_at : row.idle_since),
          Number.isFinite(resultReceivedAt) ? resultReceivedAt : 0,
        );
        return resolveProjectProviderInstanceEnabled(
          preferences,
          ProjectId.make(row.project_id),
          ProviderInstanceId.make(row.provider_instance_id),
        ) &&
          policy.idleCompactionEnabled &&
          Number.isFinite(idleSince) &&
          now - idleSince >= policy.idleCompactionMinutes * 60_000 &&
          Number.isFinite(row.used_tokens) &&
          row.used_tokens >= policy.idleCompactionTokens
          ? [{ threadId: ThreadId.make(row.thread_id), runId: RunId.make(row.run_id) }]
          : [];
      });
    },
    Effect.mapError((cause) => new IdleCompactionError({ cause })),
  );
  return IdleCompaction.of({ due });
});

export const layer = Layer.effect(IdleCompaction, make);
