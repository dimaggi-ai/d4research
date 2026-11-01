import { describe, expect, it } from "vite-plus/test";
import type { UsageLimitHistoryPoint } from "@d4research/contracts";
import { historyAccounts, historyProviderGroups, historySegments } from "./usageLimitHistoryModel";

const point = (
  minute: number,
  remaining: number,
  accountId = "personal",
): UsageLimitHistoryPoint => ({
  accountId,
  label: accountId,
  color: null,
  windowId: "session",
  windowLabel: "5h",
  measuredAt: new Date(Date.UTC(2026, 8, 13, 12, minute)).toISOString(),
  remainingPercent: remaining,
  resetsAt: "2026-09-13T17:00:00.000Z",
});
describe("usage limit trends", () => {
  it("connects resets and timestamp adjustments, marking only measurement gaps", () => {
    const segments = historySegments(
      [
        point(0, 80),
        point(5, 70),
        point(10, 100),
        point(15, 90),
        point(50, 85),
        { ...point(55, 80), resetsAt: "2026-09-13T22:00:00.000Z" },
      ],
      5,
    );
    expect(segments.map((segment) => segment.length)).toEqual([4, 2]);
  });
  it("groups accounts by provider without combining personal and work", () => {
    const groups = historyProviderGroups([
      point(0, 90, JSON.stringify(["provider", "codex", "work", null])),
      point(0, 60, JSON.stringify(["provider", "claudeAgent", "personal", null])),
      point(0, 20, JSON.stringify(["provider", "claudeAgent", "work", null])),
    ]);
    expect(groups.map((g) => [g.label, g.accounts.length])).toEqual([
      ["Claude", 2],
      ["Codex", 1],
    ]);
  });
  it("keeps personal before work regardless of arrival order or remaining quota", () => {
    const accounts = historyAccounts([
      point(0, 90, "work"),
      point(0, 10),
      point(5, 100),
      point(5, 5, "work"),
    ]);
    expect(accounts.map(([id]) => id)).toEqual(["personal", "work"]);
    expect(accounts[0]?.[1].windows.get("session")?.map((p) => p.remainingPercent)).toEqual([
      10, 100,
    ]);
  });
});
