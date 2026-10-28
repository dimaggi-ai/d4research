import { IsoDateTime, ThreadId } from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Terminal runs the Overview reports: completed work, and runs cut short that still need a resume.
const CompletedRun = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.String,
  ordinal: Schema.Number,
  status: Schema.Literals(["completed", "cancelled", "interrupted"]),
  completedAt: IsoDateTime,
});
export type TerminalRun = typeof CompletedRun.Type;
const decodeCompletedRuns = Schema.decodeUnknownEffect(Schema.Array(CompletedRun));

export class OverviewThreadsError extends Schema.TaggedError<OverviewThreadsError>()(
  "OverviewThreadsError",
  { cause: Schema.Defect() },
) {}

export class OverviewThreads extends Context.Service<
  OverviewThreads,
  {
    readonly readCompleted: () => Effect.Effect<
      ReadonlyArray<typeof CompletedRun.Type>,
      OverviewThreadsError
    >;
  }
>()("d4research/d4Agent/OverviewThreads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readCompleted = Effect.fn("OverviewThreads.readCompleted")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql`
        SELECT thread_id AS threadId, run_id AS runId, ordinal, status,
          completed_at AS completedAt
        FROM orchestration_v2_projection_runs AS completed
        WHERE status IN ('completed', 'cancelled', 'interrupted')
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS later
            WHERE later.thread_id = completed.thread_id AND later.ordinal > completed.ordinal)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS message
            WHERE message.run_id = completed.run_id
              AND json_extract(message.payload_json, '$.scheduledTaskId') IS NOT NULL)
          AND unixepoch(completed_at, 'subsec') >= ${(now - 7 * 86_400_000) / 1000}
          AND unixepoch(completed_at, 'subsec') <= ${now / 1000}
          AND json_extract(payload_json, '$.startedAt') IS NOT NULL
          AND (status <> 'completed' OR ROUND((julianday(completed_at)
            - julianday(json_extract(payload_json, '$.startedAt'))) * 86400000) >= 300000)
        ORDER BY unixepoch(completed_at, 'subsec') DESC, run_id ASC
      `;
      return yield* decodeCompletedRuns(rows);
    },
    Effect.mapError((cause) => new OverviewThreadsError({ cause })),
  );
  return OverviewThreads.of({ readCompleted });
});

export const layer = Layer.effect(OverviewThreads, make);
