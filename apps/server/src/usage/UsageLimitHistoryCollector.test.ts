import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitHistoryPoint,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { UsageLimitSources } from "./UsageLimitSources.ts";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";
import { layer, providerHistoryPoints, sourceHistoryPoints } from "./UsageLimitHistoryCollector.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("personal"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Personal",
  accentColor: "#22c55e",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "personal@example.test" },
  checkedAt: "2026-09-13T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-13T11:59:00.000Z",
    windows: [{ id: "weekly", kind: "weekly", label: "Week", usedPercent: 25 }],
  },
};
describe("usage history collection", () => {
  it("separates instances and account switches, preserves accents and actual measurement time", () => {
    const points = providerHistoryPoints([
      provider,
      { ...provider, instanceId: ProviderInstanceId.make("work") },
      { ...provider, auth: { status: "authenticated", email: "another@example.test" } },
    ]);
    expect(new Set(points.map((p) => p.accountId)).size).toBe(3);
    expect(points[0]).toMatchObject({
      remainingPercent: 75,
      measuredAt: "2026-09-13T11:59:00.000Z",
      color: "#22c55e",
      label: "Personal",
    });
  });
  it("does not record failed probes or logged-out and disabled providers", () => {
    expect(
      providerHistoryPoints([
        { ...provider, enabled: false },
        { ...provider, auth: { status: "unknown" } },
        {
          ...provider,
          usageLimits: { ...provider.usageLimits!, unavailable: { reason: "probeFailed" } },
        },
      ]),
    ).toEqual([]);
    expect(sourceHistoryPoints([])).toEqual([]);
  });
  it.effect(
    "samples on startup and every five minutes without a connected UI or extra provider probes",
    () =>
      Effect.gen(function* () {
        const recorded = yield* Queue.unbounded<readonly UsageLimitHistoryPoint[]>();
        yield* Layer.build(
          layer.pipe(
            Layer.provide(
              Layer.mock(ProviderRegistry)({
                getProviders: Effect.succeed([provider]),
                streamChanges: Stream.never,
              }),
            ),
            Layer.provide(Layer.mock(UsageLimitSources)({ current: Effect.succeed([]) })),
            Layer.provide(
              Layer.mock(UsageLimitHistory)({
                record: (points) => Queue.offer(recorded, points).pipe(Effect.asVoid),
              }),
            ),
          ),
        );
        const first = yield* Queue.take(recorded);
        expect(first).toHaveLength(1);
        yield* TestClock.adjust("5 minutes");
        const second = yield* Queue.take(recorded);
        expect(second).toEqual(first); // Cached observations retain their original timestamp.
      }).pipe(Effect.scoped),
  );
});
