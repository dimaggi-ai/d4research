import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@d4research/contracts";
import type * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeHandoffCompactionRecovery } from "./HandoffCompactionRecovery.ts";

const driver = ProviderDriverKind.make("codex");
const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
const input = {
  runId: RunId.make("run:pending"),
  attemptId: RunAttemptId.make("attempt:pending"),
  rootNodeId: NodeId.make("node:pending"),
  providerThread: {
    id: ProviderThreadId.make("thread:target"),
    contextUsage: { usedTokens: 120000, maxTokens: 128000 },
  },
  message: { text: "Original request", attachments: [] },
} as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;
const turnId = ProviderTurnId.make("turn:compaction");

const harness = Effect.fnUntraced(function* (options: {
  usage?: number;
  staleThreadUsage?: number;
  threadUsageFirst?: boolean;
  unrelatedUsage?: "thread" | "attempt";
  usageAfterTerminal?: boolean;
  terminal?: "completed" | "interrupted";
  hold?: boolean;
  unsupported?: boolean;
}) {
  const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started = yield* Deferred.make<void>();
  const observed = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
  let calls = 0;
  let interruptions = 0;
  const queue = yield* PubSub.subscribe(events);
  const recovery = makeHandoffCompactionRecovery({
    events: Stream.fromSubscription(queue),
    ...(options.unsupported
      ? {}
      : {
          compactThread: (maintenance: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              calls++;
              assert.equal(maintenance.message.text, "/compact");
              assert.notEqual(maintenance.attemptId, input.attemptId);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: turnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: maintenance.rootNodeId,
                  runAttemptId: maintenance.attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
              const publishThreadUsage =
                options.staleThreadUsage === undefined
                  ? Effect.void
                  : PubSub.publish(events, {
                      type: "provider_thread.updated",
                      driver,
                      providerThread: {
                        ...input.providerThread,
                        contextUsage: { usedTokens: options.staleThreadUsage, maxTokens: 128_000 },
                      },
                    } as ProviderAdapter.ProviderAdapterV2Event);
              if (options.threadUsageFirst) yield* publishThreadUsage;
              const publishUsage =
                options.usage === undefined
                  ? Effect.void
                  : PubSub.publish(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: turnId,
                        providerThreadId:
                          options.unrelatedUsage === "thread"
                            ? ProviderThreadId.make("thread:other")
                            : input.providerThread.id,
                        nodeId: maintenance.rootNodeId,
                        runAttemptId:
                          options.unrelatedUsage === "attempt"
                            ? input.attemptId
                            : maintenance.attemptId,
                        nativeTurnRef: null,
                        ordinal: 1,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                        tokenUsage: {
                          usedTokens: options.usage,
                          maxTokens: 128_000,
                          updatedAt: DateTime.formatIso(now),
                        },
                      },
                    });
              if (!options.usageAfterTerminal) yield* publishUsage;
              if (!options.threadUsageFirst) yield* publishThreadUsage;
              yield* Deferred.succeed(started, undefined);
              if (!options.hold)
                yield* PubSub.publish(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId: turnId,
                  runOrdinal: 1,
                  status: options.terminal ?? "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              if (options.usageAfterTerminal) yield* publishUsage;
            }),
        }),
    interruptTurn: () =>
      Effect.sync(() => {
        interruptions++;
      }),
  });
  // Subscribe before compact starts, as RunExecutionService does.
  yield* recovery.session.events.pipe(
    Stream.runForEach((event) => Deferred.succeed(observed, event)),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return {
    recovery,
    started,
    observed,
    events,
    queue,
    calls: () => calls,
    interruptions: () => interruptions,
  };
});

it.effect(
  "uses the final measured usage, hides maintenance events, and permits only one compaction",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ usage: 1234 });
        const usage = yield* h.recovery.compact(input);
        assert.equal(usage.usedTokens, 1234);
        assert.isFalse(yield* Deferred.isDone(h.observed));
        assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
        assert.equal(h.calls(), 1);
      }),
    ),
);

it.effect.each([{}, { usage: 10, terminal: "interrupted" as const }, { unsupported: true }])(
  "does not claim recovery without usable completion %j",
  (options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(options);
        assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
        assert.isAtMost(h.calls(), 1);
      }),
    ),
);

it.effect("times out and interrupts maintenance without allowing a second attempt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ hold: true });
      const running = yield* h.recovery.compact(input).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* TestClock.adjust("60 seconds");
      assert.equal((yield* Fiber.join(running))._tag, "Failure");
      assert.equal(h.interruptions(), 1);
      assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
      assert.equal(h.calls(), 1);
    }),
  ),
);

it.effect("does not forward a late compaction terminal as the pending request's completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ usage: 100 });
      yield* h.recovery.compact(input);
      yield* PubSub.publish(h.events, {
        type: "turn.terminal",
        driver,
        providerThreadId: input.providerThread.id,
        providerTurnId: turnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      const unrelated = ProviderTurnId.make("turn:unrelated");
      yield* PubSub.publish(h.events, {
        type: "turn.terminal",
        driver,
        providerThreadId: ProviderThreadId.make("thread:unrelated"),
        providerTurnId: unrelated,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      const observed = yield* Deferred.await(h.observed);
      assert.equal(observed.type, "turn.terminal");
      if (observed.type === "turn.terminal") assert.equal(observed.providerTurnId, unrelated);
    }),
  ),
);

it.effect("interrupts native maintenance when its waiting fiber is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ hold: true });
      const running = yield* h.recovery.compact(input).pipe(Effect.forkScoped);
      yield* Deferred.await(h.started);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(running);
      assert.equal(h.interruptions(), 1);
      assert.equal(input.message.text, "Original request");
    }),
  ),
);

it.effect("Claude terminal thread snapshot must not replace measured post-compaction usage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ usage: 1234, staleThreadUsage: 120000 });
      const usage = yield* h.recovery.compact(input);
      assert.equal(usage.usedTokens, 1234);
    }),
  ),
);
it.effect("unchanged thread snapshot is not a compaction measurement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ staleThreadUsage: 120000 });
      const result = yield* h.recovery.compact(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  ),
);

it.effect.each([false, true])(
  "preserves maintenance usage with thread snapshot first=%s",
  (threadUsageFirst) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ usage: 1234, staleThreadUsage: 120000, threadUsageFirst });
        assert.equal((yield* h.recovery.compact(input)).usedTokens, 1234);
      }),
    ),
);

it.effect("accepts a fresh maintenance measurement even when its value is unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ usage: 120000, staleThreadUsage: 120000 });
      assert.equal((yield* h.recovery.compact(input)).usedTokens, 120000);
    }),
  ),
);

it.effect.each(["thread", "attempt"] as const)(
  "rejects telemetry from another %s",
  (unrelatedUsage) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ usage: 1234, unrelatedUsage });
        assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
      }),
    ),
);

it.effect("does not use telemetry arriving after the maintenance terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ usage: 1234, usageAfterTerminal: true });
      assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
    }),
  ),
);

it.effect("does not infer a measurement from a changed thread-only usage value", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ staleThreadUsage: 1234 });
      assert.equal((yield* h.recovery.compact(input).pipe(Effect.result))._tag, "Failure");
    }),
  ),
);
