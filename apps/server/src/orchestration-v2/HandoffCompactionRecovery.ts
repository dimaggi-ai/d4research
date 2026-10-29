import {
  NodeId,
  RunId,
  RunAttemptId,
  type ProviderTurnId,
  type ThreadTokenUsageSnapshot,
} from "@d4research/contracts";
import * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@d4research/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Maintenance must not bind or finish the pending user attempt. Its terminal is consumed here. */
export const makeHandoffCompactionRecovery = <
  Session extends Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    "events" | "subscribeEvents" | "compactThread" | "interruptTurn"
  >,
>(
  session: Session,
) => {
  let state:
    | {
        input: ProviderAdapter.ProviderAdapterV2TurnInput;
        done: Deferred.Deferred<
          ThreadTokenUsageSnapshot,
          ContextHandoffBudgetError | ProviderAdapter.ProviderAdapterTurnStartError
        >;
        usage?: ThreadTokenUsageSnapshot;
        turnId?: ProviderTurnId;
        terminal: boolean;
      }
    | undefined;
  const maintenanceTurns = new Set<ProviderTurnId>();
  let attempted = false;
  const filter = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Effect.gen(function* () {
      if (
        !state &&
        event.type === "provider_turn.updated" &&
        maintenanceTurns.has(event.providerTurn.id)
      )
        return false;
      if (
        event.type === "turn_item.updated" &&
        event.turnItem.providerTurnId !== null &&
        maintenanceTurns.has(event.turnItem.providerTurnId)
      )
        return false;
      if (
        event.type === "turn.terminal" &&
        maintenanceTurns.has(event.providerTurnId) &&
        (!state || state.terminal)
      )
        return false;
      const current = state;
      if (!current) return true;
      switch (event.type) {
        case "provider_turn.updated":
          if (
            event.providerTurn.runAttemptId !== current.input.attemptId ||
            event.providerTurn.providerThreadId !== current.input.providerThread.id
          )
            return true;
          current.turnId = event.providerTurn.id;
          maintenanceTurns.add(event.providerTurn.id);
          if (event.providerTurn.tokenUsage)
            current.usage = {
              usedTokens: event.providerTurn.tokenUsage.usedTokens,
              ...(event.providerTurn.tokenUsage.maxTokens == null
                ? {}
                : { maxTokens: event.providerTurn.tokenUsage.maxTokens }),
            };
          return false;
        case "provider_thread.updated":
          if (event.providerThread.id !== current.input.providerThread.id) return true;
          // Thread snapshots can replay pre-compaction usage (including on Claude's
          // terminal update). They carry no measurement provenance; only telemetry
          // attributed to this maintenance attempt can establish the retry budget.
          return false;
        case "turn_item.updated":
          return event.turnItem.nodeId !== current.input.rootNodeId;
        case "node.updated":
          return event.node.id !== current.input.rootNodeId;
        case "message.updated":
          return event.message.runId !== current.input.runId;
        case "turn.terminal":
          if (
            event.providerThreadId !== current.input.providerThread.id ||
            !maintenanceTurns.has(event.providerTurnId)
          )
            return true;
          current.terminal = true;
          yield* Effect.logInfo("handoff.budget.recovery.terminal", {
            runId: current.input.runId,
            status: event.status,
            measured: current.usage !== undefined,
            ...(event.status === "failed"
              ? { failureClass: event.failure.class, failureCode: event.failure.code }
              : {}),
          });
          if (event.status === "failed") {
            yield* Deferred.fail(
              current.done,
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: event.driver,
                threadId: current.input.threadId,
                providerThreadId: event.providerThreadId,
                runId: current.input.runId,
                cause: event.failure,
              }),
            );
            return false;
          }
          if (
            event.status === "completed" &&
            event.threadDisposition === "reusable" &&
            current.usage
          )
            yield* Deferred.succeed(current.done, current.usage);
          else yield* Deferred.fail(current.done, new ContextHandoffBudgetError());
          return false;
        default:
          return true;
      }
    });
  const wrap = (events: typeof session.events) => events.pipe(Stream.filterEffect(filter));
  return {
    session: {
      ...session,
      events: wrap(session.events),
      ...(session.subscribeEvents === undefined
        ? {}
        : {
            subscribeEvents: session.subscribeEvents.pipe(
              Effect.map((subscription) => ({
                ...subscription,
                events: wrap(subscription.events),
              })),
            ),
          }),
    },
    compact: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        if (attempted || !session.compactThread) return yield* new ContextHandoffBudgetError();
        attempted = true;
        const done = yield* Deferred.make<
          ThreadTokenUsageSnapshot,
          ContextHandoffBudgetError | ProviderAdapter.ProviderAdapterTurnStartError
        >();
        const maintenanceInput = {
          ...input,
          runId: RunId.make(`${input.runId}:handoff-compaction`),
          attemptId: RunAttemptId.make(`${input.attemptId}:handoff-compaction`),
          rootNodeId: NodeId.make(`${input.rootNodeId}:handoff-compaction`),
          message: { ...input.message, text: "/compact", attachments: [] },
        };
        const current = { input: maintenanceInput, done, terminal: false } as NonNullable<
          typeof state
        >;
        state = current;
        yield* Effect.logInfo("handoff.budget.recovery", {
          strategy: "native-compaction",
          runId: input.runId,
        });
        return yield* session.compactThread(maintenanceInput).pipe(
          Effect.andThen(Deferred.await(done)),
          Effect.timeout("60 seconds"),
          Effect.onError(() =>
            current.turnId && !current.terminal
              ? session
                  .interruptTurn({
                    providerThread: input.providerThread,
                    providerTurnId: current.turnId,
                  })
                  .pipe(
                    Effect.timeout("5 seconds"),
                    Effect.catchCause(() =>
                      Effect.logWarning("handoff.budget.recovery.interrupt-failed", {
                        runId: input.runId,
                      }),
                    ),
                  )
              : Effect.void,
          ),
          Effect.ensuring(
            Effect.sync(() => {
              state = undefined;
            }),
          ),
        );
      }),
  };
};
