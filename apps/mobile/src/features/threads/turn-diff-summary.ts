import type { ThreadCheckpointSummary } from "@d4research/client-runtime/state/thread-checkpoints";
import type { RunId } from "@d4research/contracts";
import {
  threadFeedRunIsUnsettled,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";

export interface TurnDiffSummary {
  readonly checkpointTurnCount: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export function deriveTurnDiffCards(
  feed: ReadonlyArray<ThreadFeedEntry>,
  checkpoints: ReadonlyArray<ThreadCheckpointSummary>,
  latestRun: ThreadFeedLatestRun | null,
): ReadonlyMap<string, TurnDiffSummary> {
  const anchors = new Map<RunId, string>();
  const streamingRuns = new Set<RunId>();
  for (const entry of feed) {
    const runId = entry.type === "message" ? entry.message.runId : entry.runId;
    if (!runId || entry.type === "thinking") continue;
    if (entry.type === "message") {
      if (entry.message.role !== "assistant") continue;
      if (entry.message.streaming) streamingRuns.add(runId);
    }
    anchors.set(runId, entry.id);
  }
  const cards = new Map<string, TurnDiffSummary>();
  for (const checkpoint of checkpoints) {
    const anchor = anchors.get(checkpoint.runId);
    if (
      !anchor ||
      checkpoint.status !== "ready" ||
      checkpoint.files.length === 0 ||
      streamingRuns.has(checkpoint.runId) ||
      (threadFeedRunIsUnsettled(latestRun) && latestRun.runId === checkpoint.runId)
    )
      continue;
    const previous = cards.get(anchor);
    if (previous && previous.checkpointTurnCount >= checkpoint.checkpointTurnCount) continue;
    cards.set(anchor, {
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      fileCount: checkpoint.files.length,
      additions: checkpoint.files.reduce((total, file) => total + file.additions, 0),
      deletions: checkpoint.files.reduce((total, file) => total + file.deletions, 0),
    });
  }
  return cards;
}
