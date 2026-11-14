import {
  type D4AgentTranscriptEntry,
  EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  ThreadId,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { appendNiaSystemNotices } from "./d4-agent-timeline.ts";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("nia");
const notice = (
  id: string,
  minute: number,
  context: D4AgentTranscriptEntry["context"] = "Global",
): D4AgentTranscriptEntry => ({
  id,
  role: "system",
  context,
  text: "Completed: Research.\nResearch result",
  createdAt: `2026-07-28T10:${String(minute).padStart(2, "0")}:00.000Z`,
  links: [{ label: "Research", threadId: ThreadId.make("research"), projectId: null }],
});

it("retains only source-only notices in the viewed context and preserves thread links", () => {
  const items = appendNiaSystemNotices(
    [],
    [
      notice("report:global", 1),
      notice("action-created:global", 2),
      notice("archived:global", 3),
      notice("report:private", 4, "YB"),
      notice("d4-overview:existing", 5),
      notice("rotation:notice", 6),
      { ...notice("report:assistant", 7), role: "assistant" },
    ],
    environmentId,
    threadId,
    "Global",
  );
  expect(items.map(({ item }) => item.id)).toEqual([
    "report:global",
    "action-created:global",
    "archived:global",
  ]);
  const item = items[0]!.item;
  expect(item.type).toBe("notification");
  if (item.type !== "notification") throw new Error("Expected notification");
  expect(item.source).toEqual({ kind: "system" });
  expect(item.detail).toContain("Research result");
  expect(item.detail).toContain("t3-thread:");
});

it("deduplicates projected and repeated notices without reordering committed items", () => {
  const seed = appendNiaSystemNotices(
    [],
    [notice("report:late", 5), notice("report:early", 1)],
    environmentId,
    threadId,
    "Global",
  );
  const committed = [seed[1]!, seed[0]!];
  const result = appendNiaSystemNotices(
    committed,
    [notice("report:late", 5), notice("report:middle", 3), notice("report:middle", 3)],
    environmentId,
    threadId,
    "Global",
  );
  expect(result.map(({ item }) => item.id)).toEqual([
    "report:middle",
    "report:late",
    "report:early",
  ]);
  expect(result[1]).toBe(committed[0]);
  expect(result[2]).toBe(committed[1]);
  expect(DateTime.formatIso(result[0]!.item.startedAt!)).toBe("2026-07-28T10:03:00.000Z");
  expect(
    appendNiaSystemNotices(result, [notice("report:middle", 3)], environmentId, threadId, "Global"),
  ).toBe(result);
  const empty: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];
  expect(
    appendNiaSystemNotices(
      empty,
      [notice("report:private", 1, "YB")],
      environmentId,
      threadId,
      "Global",
    ),
  ).toBe(empty);
});
