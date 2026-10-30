import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/sql";
import type { UsageLimitHistoryPoint } from "@d4research/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { UsageLimitHistory, layer } from "./UsageLimitHistory.ts";

const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const point = (
  measuredAt: string,
  remainingPercent: number,
  accountId = "personal",
): UsageLimitHistoryPoint => ({
  accountId,
  label: accountId,
  color: "#22c55e",
  windowId: "weekly",
  windowLabel: "Week",
  measuredAt,
  remainingPercent,
  resetsAt: "2026-09-20T00:00:00.000Z",
});
const now = "2026-09-13T12:00:00.000Z";

describe("UsageLimitHistory", () => {
  it.effect(
    "stores independent accounts, keeps the newest reading per bucket, and ignores stale replays",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const history = yield* UsageLimitHistory;
        yield* history.record([
          point("2026-09-13T11:00:00.000Z", 80),
          point("2026-09-13T11:00:00.000Z", 20, "work"),
        ]);
        yield* history.record([point("2026-09-13T11:00:20.000Z", 75)]);
        yield* history.record([point("2026-09-13T11:00:10.000Z", 79)]);
        const result = yield* history.read({ days: 1 });
        expect(result.points).toHaveLength(2);
        expect(result.points.find((p) => p.accountId === "personal")?.remainingPercent).toBe(75);
        expect(result.points.find((p) => p.accountId === "work")?.remainingPercent).toBe(20);
        // Re-instantiating the service against the same DB retains the recorded rows.
        const reloaded = yield* Effect.gen(function* () {
          const service = yield* UsageLimitHistory;
          return yield* service.read({ days: 1 });
        }).pipe(Effect.provide(layer));
        expect(reloaded.points).toEqual(result.points);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "prunes old measurements, skips invalid/future points, and never timestamps cached data as fresh",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        const history = yield* UsageLimitHistory;
        yield* history.record([
          point(now, 70),
          point("2026-01-01T00:00:00.000Z", 90),
          point("2026-09-14T00:00:00.000Z", 10),
          point(now, -1, "invalid"),
        ]);
        yield* TestClock.adjust("1 day");
        yield* history.record([point(now, 70)]);
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`SELECT * FROM usage_limit_history`).length).toBe(1);
        yield* TestClock.adjust("90 days");
        yield* history.record([]);
        expect((yield* sql`SELECT * FROM usage_limit_history`).length).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("downsamples long ranges without combining windows or accounts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const history = yield* UsageLimitHistory;
      yield* history.record([
        point("2026-09-13T11:00:00.000Z", 80),
        point("2026-09-13T11:05:00.000Z", 75),
        point("2026-09-13T11:10:00.000Z", 60, "work"),
        { ...point("2026-09-13T11:10:00.000Z", 90), windowId: "session", windowLabel: "Session" },
      ]);
      expect((yield* history.read({ days: 1 })).points).toHaveLength(4);
      const week = yield* history.read({ days: 7 });
      expect(week.resolutionMinutes).toBe(30);
      expect(week.points).toHaveLength(3);
      expect(
        week.points.find((p) => p.accountId === "personal" && p.windowId === "weekly")
          ?.remainingPercent,
      ).toBe(75);
    }).pipe(Effect.provide(testLayer)),
  );
});
