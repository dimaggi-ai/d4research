import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest as migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 72 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [54, "UsageLimitHistory"],
        [55, "ProjectionThreadMessageContext"],
        [56, "ProjectionThreadTitleState"],
        [57, "PullRequestFilesViewed"],
        [58, "ProjectionThreadsAutoSettleDisabledAt"],
        [59, "OrchestrationV2"],
        [60, "OrchestrationV2RedundantIndexes"],
        [61, "ForkWorkspaceCompatibility"],
        [62, "ScheduledTaskWebhooks"],
        [63, "WebhookRelayDeliveries"],
        [64, "McpAppModelContext"],
        [65, "ThreadSnapshotWindowIndexes"],
        [66, "PullRequestReviewGuides"],
        [67, "ThreadFailureLookupIndex"],
        [68, "DropUnusedV1Projections"],
        [69, "CanonicalizeThreadPullRequestLinks"],
        [70, "CodexUsageNativeTurnIndex"],
        [71, "RepairClientSettlementTimestamps"],
        [72, "WebhookDedupe"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "RepairAutomaticSettlementTimestamps" },
        { migration_id: 49, name: "ProjectionProjectIcon" },
        { migration_id: 50, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 51, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 52, name: "ProjectMemories" },
        { migration_id: 53, name: "ProjectionThreadPullRequests" },
        { migration_id: 54, name: "UsageLimitHistory" },
        { migration_id: 55, name: "ProjectionThreadMessageContext" },
        { migration_id: 56, name: "ProjectionThreadTitleState" },
        { migration_id: 57, name: "PullRequestFilesViewed" },
        { migration_id: 58, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 59, name: "OrchestrationV2" },
        { migration_id: 60, name: "OrchestrationV2RedundantIndexes" },
        { migration_id: 61, name: "ForkWorkspaceCompatibility" },
        { migration_id: 62, name: "ScheduledTaskWebhooks" },
        { migration_id: 63, name: "WebhookRelayDeliveries" },
        { migration_id: 64, name: "McpAppModelContext" },
        { migration_id: 65, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 66, name: "PullRequestReviewGuides" },
        { migration_id: 67, name: "ThreadFailureLookupIndex" },
        { migration_id: 68, name: "DropUnusedV1Projections" },
        { migration_id: 69, name: "CanonicalizeThreadPullRequestLinks" },
        { migration_id: 70, name: "CodexUsageNativeTurnIndex" },
        { migration_id: 71, name: "RepairClientSettlementTimestamps" },
        { migration_id: 72, name: "WebhookDedupe" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});

it.effect("indexes batched Codex native turns without discarding duplicate candidates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 64 });
    for (const [id, driver, nativeId] of [
      ["match", "codex", "requested"],
      ["duplicate", "codex", "requested"],
      ["second", "codex", "requested-second"],
      ["other-provider", "claudeAgent", "requested"],
      ["unrelated", "codex", "unrelated"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: `attempt-${id}`,
        thread_id: `thread-${id}`,
        run_id: `run-${id}`,
        attempt_ordinal: 1,
        root_node_id: `node-${id}`,
        provider: driver,
        provider_thread_id: `provider-thread-${id}`,
        status: "completed",
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
        provider_turn_id: `turn-${id}`,
        thread_id: `thread-${id}`,
        provider_thread_id: `provider-thread-${id}`,
        node_id: `node-${id}`,
        run_attempt_id: `attempt-${id}`,
        ordinal: 1,
        status: "completed",
        payload_json: encodeJson({ nativeTurnRef: { driver, nativeId, strength: "strong" } }),
      })}`;
    }
    const lookup = sql<{ readonly provider_turn_id: string }>`
      SELECT turn.provider_turn_id
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${encodeJson(["requested", "requested-second", "missing"])})
        )
    `;
    const before = (yield* lookup).map((row) => row.provider_turn_id).toSorted();
    assert.deepStrictEqual(before, ["turn-duplicate", "turn-match", "turn-second"]);
    yield* runMigrations();
    assert.deepStrictEqual((yield* lookup).map((row) => row.provider_turn_id).toSorted(), before);

    const [statement, parameters] = lookup.compile();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
      parameters,
    );
    assert.isTrue(
      plan.some(({ detail }) =>
        /SEARCH turn USING INDEX orchestration_v2_provider_turns_codex_native_id_idx\b/.test(
          detail,
        ),
      ),
      plan.map(({ detail }) => detail).join("\n"),
    );
    assert.isFalse(plan.some(({ detail }) => /SCAN turn\b/.test(detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
