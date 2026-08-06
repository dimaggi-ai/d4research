import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadTurnUsageRow } from "./threadTurnUsage.ts";

const decodeThreadTurnUsageRow = Schema.decodeUnknownSync(ThreadTurnUsageRow);

describe("ThreadTurnUsageRow", () => {
  it("decodes persisted usage rows with nullable metrics", () => {
    const row = decodeThreadTurnUsageRow({
      turnId: "turn-1",
      provider: "codex",
      instanceId: "codex-work",
      model: "gpt-5.6-sol",
      startedAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:00:01.000Z",
      usedTokens: 1_100,
      maxTokens: 128_000,
      totalProcessedTokens: 1_500,
      inputTokens: 950,
      cachedInputTokens: 350,
      outputTokens: 150,
      reasoningOutputTokens: 60,
      toolUses: 3,
      durationMs: 2_000,
      totalCostUsd: null,
    });

    expect(row.turnId).toBe("turn-1");
    expect(row.inputTokens).toBe(950);
    expect(row.totalCostUsd).toBeNull();
  });
});
