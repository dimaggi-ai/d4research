import type { ProviderInstanceId } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";
import { providerHistoryPoints } from "./UsageLimitHistoryCollector.ts";

/** One clock per configured account, irrespective of how many threads use it. */
export class ActiveProviderLimitSchedule {
  private readonly threads = new Map<string, ProviderInstanceId>();
  private readonly checked = new Map<ProviderInstanceId, number>();

  update(threadId: string, instanceId: ProviderInstanceId, running: boolean): ProviderInstanceId[] {
    const before = new Set(this.threads.values());
    if (running) this.threads.set(threadId, instanceId);
    else this.threads.delete(threadId);
    const after = new Set(this.threads.values());
    return [...new Set([...before, ...after])].filter((id) => before.has(id) !== after.has(id));
  }

  requested(instanceId: ProviderInstanceId, now: number): void {
    if ([...this.threads.values()].includes(instanceId)) this.checked.set(instanceId, now);
    else this.checked.delete(instanceId);
  }

  due(now: number): ProviderInstanceId[] {
    return [...new Set(this.threads.values())].filter(
      (id) => now - (this.checked.get(id) ?? -Infinity) >= 30_000,
    );
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry;
    const service = yield* OrchestratorV2;
    const history = yield* UsageLimitHistory;
    const scope = yield* Scope.Scope;
    const schedule = new ActiveProviderLimitSchedule();
    const inFlight = new Set<ProviderInstanceId>();
    const trailing = new Set<ProviderInstanceId>();
    const refresh = Effect.fn("ActiveProviderLimitPolling.refresh")(function* (
      id: ProviderInstanceId,
      boundary = false,
    ) {
      if (inFlight.has(id)) {
        if (boundary) trailing.add(id);
        return;
      }
      inFlight.add(id);
      schedule.requested(id, DateTime.toEpochMillis(yield* DateTime.now));
      yield* Effect.gen(function* () {
        do {
          trailing.delete(id);
          yield* providers.refreshInstance(id).pipe(
            Effect.flatMap((snapshots) =>
              history.record(providerHistoryPoints(snapshots.filter((p) => p.instanceId === id))),
            ),
            Effect.ignoreCause({ log: true }),
          );
        } while (trailing.has(id));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.delete(id);
            trailing.delete(id);
          }),
        ),
        Effect.forkIn(scope),
      );
    });
    yield* service.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.created" ||
          event.type === "run.updated" ||
          event.type === "thread.provider-switched" ||
          event.type === "thread.deleted",
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const thread = yield* service.getThreadShell(event.threadId);
          if (!thread) return;
          const running = event.type !== "thread.deleted" && thread.activeRunId !== null;
          for (const id of schedule.update(thread.id, thread.providerInstanceId, running))
            yield* refresh(id, true);
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
    const snapshot = yield* service.getShellSnapshot();
    for (const thread of snapshot.threads) {
      if (thread.activeRunId === null) continue;
      for (const id of schedule.update(thread.id, thread.providerInstanceId, true))
        yield* refresh(id, true);
    }
    yield* Effect.gen(function* () {
      for (const id of schedule.due(DateTime.toEpochMillis(yield* DateTime.now)))
        yield* refresh(id);
    }).pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
  }),
);
