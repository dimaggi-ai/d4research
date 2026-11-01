import type { UsageLimitHistoryPoint } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { historyAxisTicks, historyPointsByDay, nearestHistoryPoint } from "./usageLimitHistoryAxis";

const point = (measuredAt: string, remainingPercent: number): UsageLimitHistoryPoint =>
  ({
    accountId: "account",
    label: "Account",
    color: null,
    windowId: "week",
    windowLabel: "Weekly",
    measuredAt,
    remainingPercent,
  }) as unknown as UsageLimitHistoryPoint;

const at = (iso: string) => Date.parse(iso);

describe("historyAxisTicks", () => {
  it("marks every local midnight inside the range", () => {
    const ticks = historyAxisTicks(at("2026-09-21T10:00:00"), at("2026-09-24T10:00:00")).filter(
      (tick) => tick.isDayStart,
    );
    expect(ticks).toHaveLength(3);
    expect(ticks.every((tick) => new Date(tick.at).getHours() === 0)).toBe(true);
  });

  it("adds hour ticks only while a day is wide enough to read", () => {
    const short = historyAxisTicks(at("2026-09-24T00:00:00"), at("2026-09-24T12:00:00"));
    expect(short.some((tick) => !tick.isDayStart)).toBe(true);

    const long = historyAxisTicks(at("2026-08-24T00:00:00"), at("2026-09-24T00:00:00"));
    expect(long.every((tick) => tick.isDayStart)).toBe(true);
  });

  it("thins day rules over a long range so labels do not collide", () => {
    const ticks = historyAxisTicks(at("2026-06-26T00:00:00"), at("2026-09-24T00:00:00"));
    expect(ticks.length).toBeLessThan(20);
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(historyAxisTicks(at("2026-09-24T00:00:00"), at("2026-09-23T00:00:00"))).toEqual([]);
  });
});

describe("nearestHistoryPoint", () => {
  it("answers with the measurement closest in time", () => {
    const points = [
      point("2026-09-24T10:00:00", 90),
      point("2026-09-24T11:00:00", 70),
      point("2026-09-24T12:00:00", 50),
    ];
    expect(nearestHistoryPoint(points, at("2026-09-24T11:20:00"))?.remainingPercent).toBe(70);
    expect(nearestHistoryPoint(points, at("2026-09-24T09:00:00"))?.remainingPercent).toBe(90);
    expect(nearestHistoryPoint([], at("2026-09-24T09:00:00"))).toBeNull();
  });
});

describe("historyPointsByDay", () => {
  it("groups by local day, newest first within and across days", () => {
    const groups = historyPointsByDay([
      point("2026-09-23T09:00:00", 80),
      point("2026-09-24T08:00:00", 60),
      point("2026-09-24T20:00:00", 40),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.points.map((p) => p.remainingPercent)).toEqual([40, 60]);
    expect(groups[1]?.points.map((p) => p.remainingPercent)).toEqual([80]);
  });
});
