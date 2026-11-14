import {
  type D4AgentTranscriptEntry,
  type D4BrainContext,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type ThreadId,
  TurnItemId,
} from "@d4research/contracts";
import { formatThreadLink } from "@d4research/shared/threadLinks";
import * as DateTime from "effect/DateTime";

export function appendNiaSystemNotices(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  transcript: ReadonlyArray<D4AgentTranscriptEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  context: D4BrainContext,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const ids = new Set(items.flatMap((row) => [row.item.id, row.sourceItemId]));
  const notices = transcript.filter(
    (entry) =>
      entry.role === "system" &&
      entry.context === context &&
      /^(?:action-created|report|archived):/.test(entry.id),
  );
  let result: OrchestrationV2ProjectedTurnItem[] | undefined;
  let nextPosition = items.reduce((next, row) => Math.max(next, row.position + 1), 0);
  let nextOrdinal = items.reduce((next, row) => Math.max(next, row.item.ordinal + 1), 0);
  for (const entry of notices) {
    const id = TurnItemId.make(entry.id);
    if (ids.has(id)) continue;
    ids.add(id);
    const at = DateTime.makeUnsafe(entry.createdAt);
    const links = entry.links.flatMap((link) =>
      link.threadId === null
        ? []
        : [formatThreadLink({ environmentId, threadId: link.threadId }, link.label)],
    );
    const detail = links.length > 0 ? `${entry.text}\n\n${links.join("\n")}` : entry.text;
    const summary = entry.text.split("\n")[0]?.trim() || entry.text;
    result ??= [...items];
    const row: OrchestrationV2ProjectedTurnItem = {
      position: nextPosition++,
      visibility: "synthetic",
      sourceThreadId: threadId,
      sourceItemId: id,
      item: {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: nextOrdinal++,
        status: "completed",
        title: summary,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "notification",
        source: { kind: "system" },
        outcome: "completed",
        summary,
        detail,
      },
    };
    // Keep committed ordering authoritative; only place supplemental notices by time.
    const insertion = result.findIndex(
      (existing) =>
        DateTime.toEpochMillis(existing.item.startedAt ?? existing.item.updatedAt) >
        DateTime.toEpochMillis(at),
    );
    if (insertion === -1) result.push(row);
    else result.splice(insertion, 0, row);
  }
  return result ?? items;
}
