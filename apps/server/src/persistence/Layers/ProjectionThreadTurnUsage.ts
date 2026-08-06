import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadTurnUsageInput,
  ListProjectionThreadTurnUsageInput,
  ProjectionThreadTurnUsage,
  ProjectionThreadTurnUsageRepository,
  type ProjectionThreadTurnUsageRepositoryShape,
} from "../Services/ProjectionThreadTurnUsage.ts";

const makeProjectionThreadTurnUsageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadTurnUsageRow = SqlSchema.void({
    Request: ProjectionThreadTurnUsage,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_turn_usage (
          thread_id,
          turn_id,
          provider,
          instance_id,
          model,
          started_at,
          updated_at,
          used_tokens,
          max_tokens,
          total_processed_tokens,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          tool_uses,
          duration_ms,
          total_cost_usd
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.provider},
          ${row.instanceId},
          ${row.model},
          ${row.startedAt},
          ${row.updatedAt},
          ${row.usedTokens},
          ${row.maxTokens},
          ${row.totalProcessedTokens},
          ${row.inputTokens},
          ${row.cachedInputTokens},
          ${row.outputTokens},
          ${row.reasoningOutputTokens},
          ${row.toolUses},
          ${row.durationMs},
          ${row.totalCostUsd}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          provider = excluded.provider,
          instance_id = excluded.instance_id,
          model = excluded.model,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          used_tokens = excluded.used_tokens,
          max_tokens = excluded.max_tokens,
          total_processed_tokens = excluded.total_processed_tokens,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          tool_uses = excluded.tool_uses,
          duration_ms = excluded.duration_ms,
          total_cost_usd = excluded.total_cost_usd
      `,
  });

  const listProjectionThreadTurnUsageRows = SqlSchema.findAll({
    Request: ListProjectionThreadTurnUsageInput,
    Result: ProjectionThreadTurnUsage,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider,
          instance_id AS "instanceId",
          model,
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          used_tokens AS "usedTokens",
          max_tokens AS "maxTokens",
          total_processed_tokens AS "totalProcessedTokens",
          input_tokens AS "inputTokens",
          cached_input_tokens AS "cachedInputTokens",
          output_tokens AS "outputTokens",
          reasoning_output_tokens AS "reasoningOutputTokens",
          tool_uses AS "toolUses",
          duration_ms AS "durationMs",
          total_cost_usd AS "totalCostUsd"
        FROM projection_thread_turn_usage
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN started_at IS NULL THEN 1 ELSE 0 END ASC,
          started_at ASC,
          updated_at ASC,
          turn_id ASC
      `,
  });

  const deleteProjectionThreadTurnUsageRows = SqlSchema.void({
    Request: DeleteProjectionThreadTurnUsageInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_turn_usage
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadTurnUsageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadTurnUsageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTurnUsageRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadTurnUsageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadTurnUsageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTurnUsageRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadTurnUsageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadTurnUsageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTurnUsageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadTurnUsageRepositoryShape;
});

export const ProjectionThreadTurnUsageRepositoryLive = Layer.effect(
  ProjectionThreadTurnUsageRepository,
  makeProjectionThreadTurnUsageRepository,
);
