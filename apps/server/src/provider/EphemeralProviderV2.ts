import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@d4research/contracts";
import { Data, DateTime, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import type {
  ProviderAdapterV2Shape,
  ProviderAdapterV2Event,
} from "../orchestration-v2/ProviderAdapter.ts";

export class EphemeralProviderError extends Data.TaggedError("EphemeralProviderError")<{
  readonly detail: string;
}> {}

/** Advisory sessions never register a durable thread or mint an MCP credential. */
export const runEphemeralProviderV2 = Effect.fn("runEphemeralProviderV2")(function* (input: {
  readonly adapter: ProviderAdapterV2Shape;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly prompts: ReadonlyArray<{
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly timeoutMillis: number;
  }>;
  readonly startTimeoutMillis: number;
}) {
  const scope = yield* Scope.make();
  return yield* Effect.gen(function* () {
    const now = yield* DateTime.now;
    const runtimePolicy = {
      cwd: input.cwd,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    };
    const runtime = yield* input.adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId: ProviderSessionId.make(`${input.threadId}:session`),
        modelSelection: input.modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.timeout(input.startTimeoutMillis));
    const providerThread = yield* runtime
      .ensureThread({
        threadId: input.threadId,
        modelSelection: input.modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.timeout(input.startTimeoutMillis));
    const appThread: OrchestrationV2AppThread = {
      id: input.threadId,
      projectId: ProjectId.make(`${input.threadId}:ephemeral`),
      title: "Advisory session",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: runtimePolicy.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: input.cwd,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    let active:
      | {
          runId: RunId;
          ordinal: number;
          completion: Deferred.Deferred<void, EphemeralProviderError>;
          messages: Map<string, string>;
        }
      | undefined;
    const handle = (event: ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending") {
          const request = event.runtimeRequest;
          yield* runtime.respondToRuntimeRequest({
            requestId: request.id,
            ...(request.kind === "user_input"
              ? { answers: {} }
              : {
                  decision: "decline" as const,
                }),
          });
        }
        if (!active) return;
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.runId === active.runId
        )
          active.messages.set(event.message.id, event.message.text);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.runId === active.runId
        )
          active.messages.set(event.turnItem.messageId, event.turnItem.text);
        if (
          event.type === "turn.terminal" &&
          event.providerThreadId === providerThread.id &&
          event.runOrdinal === active.ordinal
        ) {
          if (event.status === "completed") yield* Deferred.succeed(active.completion, undefined);
          else
            yield* Deferred.fail(
              active.completion,
              new EphemeralProviderError({
                detail: event.failure?.message ?? `Advisory provider turn ${event.status}.`,
              }),
            );
        }
      });
    const listener = yield* runtime.events.pipe(
      Stream.runForEach(handle),
      Effect.andThen(
        Effect.fail(
          new EphemeralProviderError({
            detail: "Advisory provider stream ended before completion.",
          }),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    let result = "";
    for (const [index, prompt] of input.prompts.entries()) {
      const runId = RunId.make(`${input.threadId}:run:${index}`);
      const completion = yield* Deferred.make<void, EphemeralProviderError>();
      const messages = new Map<string, string>();
      active = { runId, ordinal: index + 1, completion, messages };
      yield* Effect.gen(function* () {
        yield* runtime.startTurn({
          appThread,
          threadId: input.threadId,
          runId,
          runOrdinal: index + 1,
          providerTurnOrdinal: index + 1,
          attemptId: RunAttemptId.make(`${runId}:attempt`),
          rootNodeId: NodeId.make(`${runId}:root`),
          providerThread,
          message: {
            messageId: MessageId.make(`${runId}:prompt`),
            text: prompt.text,
            attachments: prompt.attachments ?? [],
            createdBy: "system",
            creationSource: "server",
          },
          modelSelection: input.modelSelection,
          runtimePolicy,
        });
        yield* Deferred.await(completion);
      }).pipe(Effect.raceFirst(Fiber.join(listener)), Effect.timeout(prompt.timeoutMillis));
      // A terminal receipt is authoritative. Read back when the provider offers
      // a snapshot to recover native final text that was not streamed.
      const capabilities = yield* input.adapter.getCapabilities();
      if (capabilities.threads.canReadThreadSnapshot) {
        const snapshot = yield* runtime
          .readThreadSnapshot({ providerThread })
          .pipe(Effect.timeout(input.startTimeoutMillis));
        for (const message of snapshot.messages) {
          if (message.role === "assistant" && message.runId === runId)
            messages.set(message.id, message.text);
        }
      }
      result = [...messages.values()].join("\n\n").trim();
    }
    return result;
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.ensuring(Scope.close(scope, Exit.void).pipe(Effect.timeout(10_000), Effect.ignore)),
  );
});
