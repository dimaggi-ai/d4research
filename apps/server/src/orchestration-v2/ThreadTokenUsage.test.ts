import { ThreadId } from "@d4research/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { getThreadTokenUsage } from "./ThreadTokenUsage.ts";

it.layer(SqlitePersistenceMemory)("V2 token usage", (it) => {
  it.effect("reports main-agent usage and keeps legacy history without reading tool output", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("usage-thread");
      const now = "2026-10-02T00:00:00.000Z";
      for (const [id, owner] of [
        ["root", null],
        ["child", "subagent"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, ${owner}, 'codex', 'idle', ${now}, '{"providerInstanceId":"codex-private"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at, completed_at, payload_json)
        VALUES (${`turn-${id}`}, ${threadId}, ${id}, ${`node-${id}`}, 1, 'completed', ${now}, ${now},
          '{"tokenUsage":{"usedTokens":90,"maxTokens":200,"updatedAt":"2026-10-02T00:00:00.000Z"},"turnTokenUsage":{"usageStatus":"complete","inputTokens":100,"outputTokens":20,"cachedInputTokens":10,"reasoningTokens":5}}')`;
      }
      yield* sql`INSERT INTO projection_thread_turn_usage (thread_id, turn_id, updated_at, input_tokens) VALUES (${threadId}, 'legacy-turn', ${now}, 30)`;
      const rows = yield* getThreadTokenUsage(threadId);
      assert.equal(rows.length, 2);
      const root = rows.find((row) => row.turnId === "turn-root");
      assert.isDefined(root);
      assert.equal(root?.usedTokens, 90);
      assert.equal(root?.totalProcessedTokens, 120);
      assert.equal(root?.cachedInputTokens, 10);
      assert.equal(root?.reasoningOutputTokens, 5);
      assert.isNull(root?.totalCostUsd);
      assert.equal(rows.find((row) => row.turnId === "legacy-turn")?.inputTokens, 30);
      assert.deepEqual(yield* getThreadTokenUsage(ThreadId.make("other-thread")), []);
    }),
  );
});
