import {
  CommandId,
  type CheckpointScopeId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@d4research/contracts";
import { extractTrailingEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import { parseInlineDelegateTrigger } from "@d4research/shared/researchPipeline";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import {
  InlineDelegationRunner,
  resolveInlineDelegateTarget,
} from "../mcp/toolkits/research/inlineDelegation.ts";
import * as ApplicationEvents from "../persistence/Services/OrchestrationEventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";

class InlineResearchRejected extends Data.TaggedError("InlineResearchRejected")<{
  readonly message: string;
}> {}

type EventPayload = {
  [Type in OrchestrationV2DomainEvent["type"]]: Pick<
    Extract<OrchestrationV2DomainEvent, { type: Type }>,
    "type" | "payload"
  >;
}[OrchestrationV2DomainEvent["type"]];

/** A one-shot adviser owns no provider session or selection on the visible thread. */
export const tryRunInlineResearchTurn = Effect.fn("tryRunInlineResearchTurn")(function* (input: {
  readonly run: OrchestrationV2Run;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly shareMemoContext: boolean;
  readonly nextOrdinal: number;
  readonly checkpointScopeId: CheckpointScopeId;
  readonly preparePrompt?: (text: string) => Effect.Effect<string>;
}) {
  const trigger = parseInlineDelegateTrigger(
    extractTrailingEnabledSkillsContext(input.message.text).promptText,
  );
  if (trigger === null) return false;
  const runner = yield* InlineDelegationRunner;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
  const { run, attempt, rootNode, message } = input;
  const target = resolveInlineDelegateTarget(trigger.directive, input.providers);
  const now = yield* DateTime.now;
  const itemBase = {
    threadId: message.threadId,
    runId: run.id,
    nodeId: rootNode.id,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  } as const;
  const toolItem: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> = {
    ...itemBase,
    id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "inline-research" }),
    ordinal: input.nextOrdinal,
    status: "running",
    type: "dynamic_tool",
    title: "Research delegation",
    toolName: "research_delegate",
    input: { target: trigger.directive.raw, prompt: trigger.task },
  };
  const event = (payload: OrchestrationV2DomainEvent, occurredAt = now) => ({
    ...payload,
    occurredAt,
  });
  const wrap = (payload: EventPayload) =>
    Effect.gen(function* () {
      return {
        ...payload,
        id: yield* ids.allocate.event({ threadId: message.threadId }),
        threadId: message.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
      };
    });
  const started = yield* sink.writeIfRunCurrent({
    threadId: message.threadId,
    runId: run.id,
    activeAttemptId: attempt.id,
    expectedStatus: "starting",
    events: yield* Effect.forEach(
      [
        { type: "turn-item.updated", payload: toolItem },
        { type: "run.updated", payload: { ...run, status: "running", startedAt: now } },
        { type: "run-attempt.updated", payload: { ...attempt, status: "running", startedAt: now } },
        { type: "node.updated", payload: { ...rootNode, status: "running", startedAt: now } },
      ] as const,
      wrap,
    ),
  });
  if (!started.committed) return true;
  const afterSequence = Math.max(0, ...started.storedEvents.map((stored) => stored.sequence));
  // Replay-to-live catches a stop committed between the start receipt and subscription.
  const cancelled = applicationEvents.streamApplicationEvents({ afterSequence }).pipe(
    Stream.filter(
      (stored) =>
        "event" in stored &&
        stored.event.type === "run.updated" &&
        stored.event.payload.id === run.id &&
        stored.event.payload.status === "interrupted",
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.andThen(Effect.interrupt),
  );
  const work = Effect.gen(function* () {
    if (!target.ok) return yield* new InlineResearchRejected({ message: target.detail });
    if (message.text.includes("<handoff_context>")) {
      return yield* new InlineResearchRejected({
        message:
          "A delegation cannot carry a provider handoff. Send the handoff as a normal message first.",
      });
    }
    return yield* runner.run({
      orchestratorThreadId: message.threadId,
      runId: `${message.threadId}:${run.id}`,
      requestedTarget: target.target.resolvedTarget,
      resolvedTarget: target.target.resolvedTarget,
      substituted: false,
      parsedTarget: { instanceId: target.target.instanceId, model: target.target.model },
      prompt: input.preparePrompt ? yield* input.preparePrompt(trigger.task) : trigger.task,
      attachments: message.attachments,
      resolvePromptFile: Effect.succeed(null),
      shareMemoContext: input.shareMemoContext,
      step: "inline",
      visit: 1,
    });
  });
  yield* work.pipe(
    Effect.raceFirst(cancelled),
    Effect.onExit((outcome) =>
      Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        const interrupted = Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause);
        const status = interrupted
          ? "interrupted"
          : Exit.isSuccess(outcome)
            ? "completed"
            : "failed";
        const text = Exit.isSuccess(outcome)
          ? outcome.value.text
          : interrupted
            ? "Research delegation interrupted."
            : makeProviderFailure({
                cause: Cause.squash(outcome.cause),
                message: String(Cause.squash(outcome.cause)),
              }).message;
        const messageId = MessageId.make(`${run.id}:inline-research-answer`);
        const resultItems: Array<EventPayload> = [
          {
            type: "turn-item.updated",
            payload: {
              ...toolItem,
              status,
              completedAt,
              updatedAt: completedAt,
              output: {
                text,
                researchDelegate: {
                  target: target.ok ? target.target.resolvedTarget : trigger.directive.raw,
                  failed: status !== "completed",
                },
              },
            },
          },
        ];
        if (!interrupted)
          resultItems.push(
            {
              type: "message.updated",
              payload: {
                id: messageId,
                threadId: message.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                role: "assistant",
                text,
                attachments: [],
                streaming: false,
                createdBy: "system",
                creationSource: "server",
                createdAt: completedAt,
                updatedAt: completedAt,
              },
            },
            {
              type: "turn-item.updated",
              payload: {
                ...itemBase,
                id: ids.derive.runSignalTurnItem({
                  runId: run.id,
                  signal: "inline-research-answer",
                }),
                ordinal: input.nextOrdinal + 1,
                type: "assistant_message",
                title: null,
                messageId,
                text,
                streaming: false,
                status,
                completedAt,
                updatedAt: completedAt,
              },
            },
            {
              type: "run.updated",
              payload: {
                ...run,
                status: status === "completed" ? "waiting" : status,
                startedAt: now,
                completedAt: status === "completed" ? null : completedAt,
              },
            },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, startedAt: now, completedAt },
            },
            {
              type: "node.updated",
              payload: {
                ...rootNode,
                status: status === "completed" ? "waiting" : status,
                startedAt: now,
                completedAt: status === "completed" ? null : completedAt,
              },
            },
          );
        yield* sink.writeIfRunCurrent({
          threadId: message.threadId,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: interrupted ? "interrupted" : "running",
          effects:
            status === "failed"
              ? []
              : [
                  {
                    id: `effect:checkpoint.capture:${run.id}`,
                    commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
                    threadId: run.threadId,
                    request: {
                      type: "checkpoint.capture",
                      runId: run.id,
                      scopeId: input.checkpointScopeId,
                    },
                  },
                ],
          events: (yield* Effect.forEach(resultItems, wrap)).map((entry) =>
            event(entry, completedAt),
          ),
        });
      }),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("Inline research delegation stopped", { cause }),
    ),
  );
  return true;
});
