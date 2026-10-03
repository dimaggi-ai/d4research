import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ProjectedTurnItem } from "@d4research/contracts";
import { researchActivitiesFromTurnItems } from "./researchTimeline";
import { makeStreamingTimelineFixture } from "./test-fixtures";
import { deriveResearchDelegations } from "./components/chat/ResearchProgressBanner";

describe("research V2 timeline", () => {
  it.each(["idle", "pending"] as const)("does not claim a %s delegate ran", (status) => {
    const row = makeStreamingTimelineFixture().visibleTurnItems.find(
      ({ item }) => item.type === "dynamic_tool",
    )!;
    if (row.item.type !== "dynamic_tool") throw new Error("Missing tool fixture");
    expect(researchActivitiesFromTurnItems([{ ...row, item: { ...row.item, status } }])).toEqual(
      [],
    );
  });
  it.each(["completed", "failed", "interrupted", "cancelled", "running"] as const)(
    "shows the actual %s delegation outcome and resolved target",
    (status) => {
      const row = makeStreamingTimelineFixture().visibleTurnItems.find(
        ({ item }) => item.type === "dynamic_tool",
      )!;
      if (row.item.type !== "dynamic_tool") throw new Error("Missing tool fixture");
      const activities = researchActivitiesFromTurnItems([
        {
          ...row,
          item: {
            ...row.item,
            status,
            toolName: "research_delegate",
            input: { target: "requested" },
            output: { researchDelegate: { target: "resolved", failed: status !== "completed" } },
          },
        },
      ]);
      expect(deriveResearchDelegations(activities)).toMatchObject([
        {
          target: "resolved",
          settled: status !== "running",
          failed: status !== "running" && status !== "completed",
        },
      ]);
    },
  );
  it("preserves controller manifests and failed delegation receipts without inventing tool calls", () => {
    const fixture = makeStreamingTimelineFixture();
    const row = fixture.visibleTurnItems.find(({ item }) => item.type === "dynamic_tool")!;
    if (row.item.type !== "dynamic_tool") throw new Error("Missing tool fixture");
    const manifest = { scenario: "bounded", pipelineHash: "verified-hash", targets: [] };
    const rows: OrchestrationV2ProjectedTurnItem[] = [
      {
        ...row,
        item: {
          ...row.item,
          type: "system_notice",
          message: "Research run",
          title: "Research run",
          activity: { kind: "research.run.started", payload: manifest },
        },
      },
      {
        ...row,
        position: row.position + 1,
        item: {
          ...row.item,
          type: "dynamic_tool",
          status: "failed",
          toolName: "research_delegate",
          input: { target: "codex:test" },
          output: { researchDelegate: { target: "codex:test", failed: true } },
        },
      },
    ];
    const activities = researchActivitiesFromTurnItems(rows);
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({ kind: "research.run.started", payload: manifest });
    expect(activities[1]).toMatchObject({
      kind: "tool.completed",
      tone: "error",
      payload: {
        data: {
          isError: true,
          output: { researchDelegate: { target: "codex:test", failed: true } },
        },
      },
    });
    expect(
      researchActivitiesFromTurnItems(fixture.visibleTurnItems).every((activity) =>
        activity.kind.startsWith("tool."),
      ),
    ).toBe(true);
  });
});
