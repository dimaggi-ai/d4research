import { describe, expect, it, vi } from "vite-plus/test";

import { TurnId, type ThreadTurnUsageRow } from "@t3tools/contracts";

import {
  sortThreadTurnUsageRows,
  startSystemMonitorPolling,
  sumThreadTurnUsageRows,
  SYSTEM_MONITOR_POLL_INTERVAL_MS,
} from "./SystemPanel";

describe("SystemPanel", () => {
  it("refreshes automatically every two seconds", () => {
    const refresh = vi.fn();
    const cancel = vi.fn();
    let scheduledRefresh: () => void = () => undefined;
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      scheduledRefresh = callback;
      expect(intervalMs).toBe(2_000);
      return 42;
    });

    const stop = startSystemMonitorPolling(refresh, schedule, cancel);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(SYSTEM_MONITOR_POLL_INTERVAL_MS).toBe(2_000);
    scheduledRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("sorts turn usage chronologically and sums nullable metrics", () => {
    const rows: ReadonlyArray<ThreadTurnUsageRow> = [
      {
        turnId: TurnId.make("turn-2"),
        provider: "codex",
        instanceId: "codex",
        model: "gpt-5.6-sol",
        startedAt: "2026-08-05T10:01:00.000Z",
        updatedAt: "2026-08-05T10:01:05.000Z",
        usedTokens: 200,
        maxTokens: 128_000,
        totalProcessedTokens: 300,
        inputTokens: 120,
        cachedInputTokens: null,
        outputTokens: 80,
        reasoningOutputTokens: 20,
        toolUses: 2,
        durationMs: 2_000,
        totalCostUsd: 0.02,
      },
      {
        turnId: TurnId.make("turn-1"),
        provider: "codex",
        instanceId: "codex",
        model: "gpt-5.6-sol",
        startedAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:05.000Z",
        usedTokens: 100,
        maxTokens: 128_000,
        totalProcessedTokens: 150,
        inputTokens: 60,
        cachedInputTokens: 30,
        outputTokens: 40,
        reasoningOutputTokens: null,
        toolUses: 1,
        durationMs: 1_000,
        totalCostUsd: 0.01,
      },
    ];

    expect(sortThreadTurnUsageRows(rows).map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(sumThreadTurnUsageRows(rows)).toEqual({
      inputTokens: 180,
      cachedInputTokens: 30,
      outputTokens: 120,
      reasoningOutputTokens: 20,
      totalProcessedTokens: 450,
      toolUses: 3,
      durationMs: 3_000,
      totalCostUsd: 0.03,
    });
  });
});
