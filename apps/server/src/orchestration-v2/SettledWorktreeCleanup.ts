import type { OrchestrationV2ThreadShell } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { threadHasQueuedTurnStart } from "./ThreadSettlementService.ts";

const SETTLED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Metadata refreshes and new activity restart the fork's seven-day retention. */
export function isSettledWorktreeExpired(thread: OrchestrationV2ThreadShell, now: number): boolean {
  if (
    thread.settledAt === null ||
    thread.settledOverride === "active" ||
    !thread.worktreePath ||
    !thread.branch ||
    thread.activeRunId !== null ||
    (thread.status !== "idle" && thread.status !== "failed") ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    threadHasQueuedTurnStart(thread, now)
  )
    return false;
  const timestamps = [
    thread.settledAt,
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestRunRequestedAt,
    thread.latestRunStartedAt,
    thread.latestRunCompletedAt,
  ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)]));
  return (
    timestamps.every(Number.isFinite) &&
    Math.max(...timestamps) <= now - SETTLED_WORKTREE_RETENTION_MS
  );
}
