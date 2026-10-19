import { describe, expect, it } from "vite-plus/test";
import { CheckpointRef, MessageId, RunId, ThreadId } from "@d4research/contracts";
import type { ThreadCheckpointSummary } from "@d4research/client-runtime/state/thread-checkpoints";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { deriveTurnDiffCards } from "./turn-diff-summary";

const runId = RunId.make("run-1");
const date = "2026-10-19T00:00:00.000Z";
const checkpoint: ThreadCheckpointSummary = {
  runId,
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
  status: "ready",
  files: [
    { path: "a.ts", kind: "modified", additions: 4, deletions: 2 },
    { path: "b.ts", kind: "added", additions: 7, deletions: 0 },
  ],
  assistantMessageId: MessageId.make("final"),
  completedAt: date,
};
function message(id: string, streaming = false): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: date,
    message: {
      id: MessageId.make(id),
      runId,
      role: "assistant",
      text: id,
      streaming,
      attachments: [],
      createdAt: date,
      updatedAt: date,
      visibility: "local",
      sourceThreadId: ThreadId.make("thread"),
    },
  };
}

describe("deriveTurnDiffCards", () => {
  it("adds one card after the final visible row and totals stored file statistics", () => {
    expect([
      ...deriveTurnDiffCards([message("first"), message("final")], [checkpoint], null),
    ]).toEqual([["final", { checkpointTurnCount: 1, fileCount: 2, additions: 11, deletions: 2 }]]);
  });
  it.each(["missing", "error", "stale"] as const)("omits %s checkpoints", (status) => {
    expect(deriveTurnDiffCards([message("final")], [{ ...checkpoint, status }], null).size).toBe(0);
  });
  it("omits empty summaries and checkpoints outside the loaded feed", () => {
    expect(deriveTurnDiffCards([message("final")], [{ ...checkpoint, files: [] }], null).size).toBe(
      0,
    );
    expect(deriveTurnDiffCards([], [checkpoint], null).size).toBe(0);
  });
  it("omits streaming and unsettled turns even when a checkpoint is present", () => {
    expect(deriveTurnDiffCards([message("final", true)], [checkpoint], null).size).toBe(0);
    expect(
      deriveTurnDiffCards([message("final")], [checkpoint], {
        runId,
        status: "running",
        startedAt: date,
        completedAt: null,
      }).size,
    ).toBe(0);
  });
  it("retains historical cards while a different turn runs", () => {
    expect(
      deriveTurnDiffCards([message("final")], [checkpoint], {
        runId: RunId.make("run-2"),
        status: "running",
        startedAt: date,
        completedAt: null,
      }).size,
    ).toBe(1);
  });
  it("supports a completed turn without an assistant message", () => {
    const work: ThreadFeedEntry = {
      type: "work-toggle",
      id: "work",
      runId,
      createdAt: date,
      groupId: "group",
      hiddenCount: 2,
      expanded: false,
      summary: "Edited files",
      summaryKind: "mixed",
      hasFailure: false,
      live: false,
      shimmer: false,
    };
    expect(
      deriveTurnDiffCards([work], [{ ...checkpoint, assistantMessageId: null }], null).has("work"),
    ).toBe(true);
  });
  it("deduplicates checkpoints for a run using its latest checkpoint", () => {
    const newer = { ...checkpoint, checkpointTurnCount: 2 };
    const cards = deriveTurnDiffCards([message("final")], [newer, checkpoint], null);
    expect(cards.size).toBe(1);
    expect(cards.get("final")?.checkpointTurnCount).toBe(2);
  });
});
