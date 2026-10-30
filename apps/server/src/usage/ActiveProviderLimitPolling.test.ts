import * as Deferred from "effect/Deferred";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  RunId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ActiveProviderLimitSchedule, layer } from "./ActiveProviderLimitPolling.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const personal = ProviderInstanceId.make("personal");
const work = ProviderInstanceId.make("work");
describe("active provider limit polling", () => {
  it("checks first start, once each 30 seconds, and last finish across concurrent threads", () => {
    const schedule = new ActiveProviderLimitSchedule();
    expect(schedule.update("a", work, true)).toEqual([work]);
    schedule.requested(work, 1000);
    expect(schedule.update("b", work, true)).toEqual([]);
    expect(schedule.due(30_999)).toEqual([]);
    expect(schedule.due(31_000)).toEqual([work]);
    schedule.requested(work, 31_000);
    expect(schedule.update("a", work, false)).toEqual([]);
    expect(schedule.update("b", work, false)).toEqual([work]);
    schedule.requested(work, 32_000);
    expect(schedule.due(100_000)).toEqual([]);
    expect(schedule.update("b", work, false)).toEqual([]);
  });
  it("keeps separate account clocks and handles provider switches", () => {
    const schedule = new ActiveProviderLimitSchedule();
    schedule.update("a", personal, true);
    schedule.requested(personal, 0);
    expect(schedule.update("b", work, true)).toEqual([work]);
    schedule.requested(work, 20_000);
    expect(schedule.due(30_000)).toEqual([personal]);
    expect(schedule.update("a", work, true)).toEqual([personal]);
  });
  it.effect("refreshes and records without a UI, stopping after work ends", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      const subscribed = yield* Deferred.make<void>();
      const requests = yield* Queue.unbounded<ProviderInstanceId>();
      let recorded = 0;
      const active = new Map<string, boolean>();
      yield* Layer.build(
        layer.pipe(
          Layer.provide(
            Layer.mock(OrchestratorV2)({
              streamDomainEvents: Stream.unwrap(
                PubSub.subscribe(events).pipe(
                  Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                  Effect.map(Stream.fromSubscription),
                ),
              ),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 2,
                  threads: [],
                  archivedThreads: [],
                  snapshotSequence: 0,
                }),
              getThreadShell: (id) =>
                Effect.sync(() =>
                  shell({
                    id,
                    providerInstanceId: work,
                    activeRunId: active.get(id) ? RunId.make("run:" + id) : null,
                  }),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed([]),
              refreshInstance: (id) => Queue.offer(requests, id).pipe(Effect.as([])),
            }),
          ),
          Layer.provide(
            Layer.mock(UsageLimitHistory)({
              record: () =>
                Effect.sync(() => {
                  recorded++;
                }),
            }),
          ),
        ),
      );
      yield* Deferred.await(subscribed);
      const publish = (id: string, running: boolean) =>
        Effect.gen(function* () {
          active.set(id, running);
          const now = yield* DateTime.now;
          yield* PubSub.publish(events, {
            id: EventId.make("event:" + id),
            type: "run.updated",
            threadId: ThreadId.make(id),
            occurredAt: now,
            payload: {
              id: RunId.make("run:" + id),
              threadId: ThreadId.make(id),
              ordinal: 1,
              providerInstanceId: work,
              modelSelection: { instanceId: work, model: "test" },
              providerThreadId: null,
              userMessageId: MessageId.make("message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: running ? "running" : "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: running ? null : now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
        });
      yield* publish("thread", true);
      expect(yield* Queue.take(requests)).toBe(work);
      yield* publish("second", true);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.size(requests)).toBe(0);
      yield* TestClock.adjust("29999 millis");
      expect(yield* Queue.take(requests)).toBe(work);
      yield* publish("thread", false);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.size(requests)).toBe(0);
      yield* publish("second", false);
      expect(yield* Queue.take(requests)).toBe(work);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Queue.size(requests)).toBe(0);
      expect(recorded).toBe(3);
    }).pipe(Effect.scoped),
  );
});
