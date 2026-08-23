import { ProviderInstanceId, ThreadId, TurnId } from "@d4research/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadTurnUsageRepository } from "../Services/ProjectionThreadTurnUsage.ts";
import { ProjectionThreadTurnUsageRepositoryLive } from "./ProjectionThreadTurnUsage.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadTurnUsageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadTurnUsageRepository", (it) => {
  it.effect("upserts, lists, and deletes per-turn usage", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadTurnUsageRepository;
      const threadId = ThreadId.make("thread-usage");
      const turnId = TurnId.make("turn-usage");

      yield* repository.upsert({
        threadId,
        turnId,
        provider: "codex",
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5.6-sol",
        startedAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:01.000Z",
        usedTokens: 900,
        maxTokens: 128_000,
        totalProcessedTokens: 1_200,
        inputTokens: 800,
        cachedInputTokens: 300,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        toolUses: 2,
        durationMs: 1_500,
        totalCostUsd: 0.0125,
      });

      yield* repository.upsert({
        threadId,
        turnId,
        provider: "codex",
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5.6-sol",
        startedAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:02.000Z",
        usedTokens: 1_100,
        maxTokens: 128_000,
        totalProcessedTokens: 1_500,
        inputTokens: 950,
        cachedInputTokens: 350,
        outputTokens: 150,
        reasoningOutputTokens: 60,
        toolUses: 3,
        durationMs: 2_000,
        totalCostUsd: 0.02,
      });

      assert.deepEqual(yield* repository.listByThreadId({ threadId }), [
        {
          threadId,
          turnId,
          provider: "codex",
          instanceId: "codex-work",
          model: "gpt-5.6-sol",
          startedAt: "2026-08-05T10:00:00.000Z",
          updatedAt: "2026-08-05T10:00:02.000Z",
          usedTokens: 1_100,
          maxTokens: 128_000,
          totalProcessedTokens: 1_500,
          inputTokens: 950,
          cachedInputTokens: 350,
          outputTokens: 150,
          reasoningOutputTokens: 60,
          toolUses: 3,
          durationMs: 2_000,
          totalCostUsd: 0.02,
        },
      ]);

      yield* repository.deleteByThreadId({ threadId });
      assert.deepEqual(yield* repository.listByThreadId({ threadId }), []);
    }),
  );
});
