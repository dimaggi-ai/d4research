import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderTurnId as TurnId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as Adapter from "@d4research/provider-core/server/ProviderAdapter";
import type { ProviderAdapterDriver } from "@d4research/provider-core/server/adapterDriver";
import {
  DeepSeekSettings,
  DEFAULT_DEEPSEEK_ENDPOINT,
  DEFAULT_DEEPSEEK_MODEL,
} from "../settings.ts";
import { deepSeekCapabilities } from "./capabilities.ts";
import { requestCompletion, type ChatMessage } from "./http.ts";

const DRIVER = ProviderDriverKind.make("deepseek");
export type DeepSeekAdapterV2DriverEnv = HttpClient.HttpClient;
const unsupported = (detail: string) =>
  Effect.fail(new Adapter.ProviderAdapterProtocolError({ driver: DRIVER, detail }));

export const DeepSeekAdapterV2Driver: ProviderAdapterDriver<
  DeepSeekSettings,
  DeepSeekAdapterV2DriverEnv
> = {
  driverKind: DRIVER,
  configSchema: DeepSeekSettings,
  defaultConfig: () => ({
    enabled: false,
    endpoint: DEFAULT_DEEPSEEK_ENDPOINT,
    model: DEFAULT_DEEPSEEK_MODEL,
    contextWindowTokens: 32768,
    requestTimeoutMs: 120000,
    smartRouting: false,
    taskMode: "text",
    fallbackInstanceId: "",
    fallbackModel: "",
  }),
  create: ({ instanceId, enabled, config }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return Adapter.ProviderAdapterV2.of({
        instanceId,
        driver: DRIVER,
        getCapabilities: () => Effect.succeed(deepSeekCapabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            if (!enabled)
              return yield* new Adapter.ProviderAdapterOpenSessionError({
                driver: DRIVER,
                providerSessionId: sessionInput.providerSessionId,
              });
            const scope = yield* Effect.scope;
            const queue = yield* Effect.acquireRelease(
              Queue.unbounded<Adapter.ProviderAdapterV2Event>(),
              Queue.shutdown,
            );
            const history = new Map<ProviderThreadId, ReadonlyArray<ChatMessage>>();
            const contexts = new Map<ProviderThreadId, string>();
            const active = new Map<TurnId, Fiber.Fiber<void>>();
            const threads = new Map<ProviderThreadId, OrchestrationV2ProviderThread>();
            const turns = new Map<ProviderThreadId, OrchestrationV2ProviderTurn[]>();
            const messages = new Map<ProviderThreadId, OrchestrationV2ConversationMessage[]>();
            const emit = (event: Adapter.ProviderAdapterV2Event) =>
              Queue.offer(queue, event).pipe(Effect.asVoid);
            const now = yield* DateTime.now;
            const providerSession = {
              id: sessionInput.providerSessionId,
              driver: DRIVER,
              providerInstanceId: instanceId,
              status: "ready" as const,
              cwd: sessionInput.runtimePolicy.cwd ?? "/",
              model: config.model,
              capabilities: deepSeekCapabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            };
            return {
              instanceId,
              driver: DRIVER,
              providerSessionId: sessionInput.providerSessionId,
              providerSession,
              events: Stream.fromQueue(queue),
              getModelContextWindow: () => config.contextWindowTokens,
              canReuseContextUsage: (previous, next) => previous.model === next.model,
              ensureThread: (input) =>
                Effect.gen(function* () {
                  const time = yield* DateTime.now;
                  const thread: OrchestrationV2ProviderThread = input.existingProviderThread
                    ? {
                        ...input.existingProviderThread,
                        providerSessionId: sessionInput.providerSessionId,
                        status: "idle",
                        updatedAt: time,
                      }
                    : {
                        id: ProviderThreadId.make(`deepseek:${instanceId}:${input.threadId}`),
                        driver: DRIVER,
                        providerInstanceId: instanceId,
                        providerSessionId: sessionInput.providerSessionId,
                        appThreadId: input.threadId,
                        ownerNodeId: null,
                        nativeThreadRef: null,
                        nativeConversationHeadRef: null,
                        status: "idle",
                        firstRunOrdinal: null,
                        lastRunOrdinal: null,
                        handoffIds: [],
                        forkedFrom: null,
                        pendingBackgroundTasks: [],
                        contextUsage: null,
                        nativeMetadata: null,
                        goal: null,
                        createdAt: time,
                        updatedAt: time,
                      };
                  threads.set(thread.id, thread);
                  yield* emit({
                    type: "provider_thread.updated",
                    driver: DRIVER,
                    providerThread: thread,
                  });
                  return thread;
                }),
              resumeThread: ({ providerThread }) =>
                Effect.sync(() => {
                  threads.set(providerThread.id, providerThread);
                  return providerThread;
                }),
              injectHistory: (input) =>
                Effect.sync(() => {
                  history.set(
                    input.providerThread.id,
                    input.messages.map((message) => ({
                      role: message.role,
                      content: message.text,
                    })),
                  );
                  contexts.set(input.providerThread.id, input.context);
                  return true;
                }),
              startTurn: (input) =>
                Effect.gen(function* () {
                  if (
                    (input.modelSelection.options?.find((option) => option.id === "taskMode")
                      ?.value ?? config.taskMode) === "tools" ||
                    input.message.attachments.length > 0 ||
                    input.modelSelection.model !== config.model ||
                    active.size > 0
                  ) {
                    return yield* new Adapter.ProviderAdapterTurnStartError({
                      driver: DRIVER,
                      threadId: input.threadId,
                      providerThreadId: input.providerThread.id,
                      runId: input.runId,
                    });
                  }
                  // Resume without authoritative history must fail rather than silently lose the conversation.
                  if (
                    (input.nativeThreadHasTurns || input.providerThread.lastRunOrdinal !== null) &&
                    !history.has(input.providerThread.id)
                  )
                    return yield* unsupported(
                      "Conversation history is required before continuing a local DeepSeek thread",
                    );
                  const startedAt = yield* DateTime.now;
                  const turnId = ProviderTurnId.make(`deepseek:${instanceId}:${input.attemptId}`);
                  let turn: OrchestrationV2ProviderTurn = {
                    id: turnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: null,
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  };
                  const previous = history.get(input.providerThread.id) ?? [];
                  const context = [
                    contexts.get(input.providerThread.id),
                    ...(input.appContext ?? []).map((entry) => entry.text),
                  ]
                    .filter((text): text is string => !!text)
                    .join("\n\n");
                  const requestMessages: ChatMessage[] = [
                    {
                      role: "system",
                      content:
                        "You are a text-only local assistant. You cannot call tools, execute commands, access files, use MCP, or perform external actions. Do not claim to have performed actions.",
                    },
                    ...(context ? [{ role: "system" as const, content: context }] : []),
                    ...previous,
                    { role: "user", content: input.message.text },
                  ];
                  yield* emit({
                    type: "provider_turn.updated",
                    driver: DRIVER,
                    threadId: input.threadId,
                    providerTurn: turn,
                  });
                  const finish = (status: "completed" | "interrupted" | "failed", code?: string) =>
                    Effect.gen(function* () {
                      const completedAt = yield* DateTime.now;
                      turn = { ...turn, status, completedAt };
                      turns.set(input.providerThread.id, [
                        ...(turns.get(input.providerThread.id) ?? []),
                        turn,
                      ]);
                      yield* emit({
                        type: "provider_turn.updated",
                        driver: DRIVER,
                        threadId: input.threadId,
                        providerTurn: turn,
                      });
                      active.delete(turnId);
                      if (status === "failed") {
                        yield* emit({
                          type: "turn.terminal",
                          driver: DRIVER,
                          providerThreadId: input.providerThread.id,
                          providerTurnId: turnId,
                          runOrdinal: input.runOrdinal,
                          failureItemOrdinal: 2,
                          status,
                          failure: {
                            class: "provider_error",
                            message: "The local DeepSeek request failed.",
                            code: code ?? "transport",
                            retryable: false,
                          },
                          threadDisposition: "reusable",
                        });
                      } else {
                        yield* emit({
                          type: "turn.terminal",
                          driver: DRIVER,
                          providerThreadId: input.providerThread.id,
                          providerTurnId: turnId,
                          runOrdinal: input.runOrdinal,
                          status,
                          failure: null,
                          threadDisposition: "reusable",
                        });
                      }
                    });
                  const work = Effect.gen(function* () {
                    const result = yield* requestCompletion(client, config, requestMessages);
                    const completedAt = yield* DateTime.now;
                    if (result.usage)
                      turn = {
                        ...turn,
                        tokenUsage: {
                          usedTokens: result.usage.total_tokens,
                          maxTokens: config.contextWindowTokens,
                          inputTokens: result.usage.prompt_tokens,
                          outputTokens: result.usage.completion_tokens,
                          updatedAt: DateTime.formatIso(completedAt),
                        },
                      };
                    const message: OrchestrationV2ConversationMessage = {
                      id: MessageId.make(`${turnId}:assistant`),
                      threadId: input.threadId,
                      runId: input.runId,
                      nodeId: input.rootNodeId,
                      role: "assistant",
                      text: result.text,
                      attachments: [],
                      streaming: false,
                      createdBy: "agent",
                      creationSource: "provider",
                      createdAt: completedAt,
                      updatedAt: completedAt,
                    };
                    history.set(input.providerThread.id, [
                      ...previous,
                      { role: "user", content: input.message.text },
                      { role: "assistant", content: result.text },
                    ]);
                    messages.set(input.providerThread.id, [
                      ...(messages.get(input.providerThread.id) ?? []),
                      message,
                    ]);
                    yield* emit({
                      type: "turn_item.updated",
                      driver: DRIVER,
                      turnItem: {
                        id: TurnItemId.make(`${turnId}:assistant`),
                        threadId: input.threadId,
                        runId: input.runId,
                        nodeId: input.rootNodeId,
                        providerThreadId: input.providerThread.id,
                        providerTurnId: turnId,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 1,
                        status: "completed",
                        title: null,
                        startedAt,
                        completedAt,
                        updatedAt: completedAt,
                        type: "assistant_message",
                        messageId: message.id,
                        text: result.text,
                        attachments: [],
                        streaming: false,
                      },
                    });
                    yield* emit({ type: "message.updated", driver: DRIVER, message });
                    yield* finish("completed");
                  }).pipe(
                    Effect.catchTags({
                      DeepSeekRequestError: (error) => finish("failed", error.category),
                    }),
                    Effect.onInterrupt(() => finish("interrupted")),
                  );
                  const fiber = yield* work.pipe(Effect.forkIn(scope, { startImmediately: false }));
                  active.set(turnId, fiber);
                }),
              steerTurn: (input) =>
                Effect.fail(
                  new Adapter.ProviderAdapterSteerRunUnsupportedError({
                    driver: DRIVER,
                    providerThreadId: input.providerThread.id,
                  }),
                ),
              interruptTurn: (input) =>
                Effect.gen(function* () {
                  const fiber = active.get(input.providerTurnId);
                  if (fiber) yield* Fiber.interrupt(fiber);
                }),
              respondToRuntimeRequest: () =>
                unsupported("Local DeepSeek does not execute actions or accept tool approvals"),
              readThreadSnapshot: ({ providerThread }) =>
                Effect.succeed({
                  providerThread,
                  providerTurns: turns.get(providerThread.id) ?? [],
                  messages: messages.get(providerThread.id) ?? [],
                  runtimeRequests: [],
                }),
              rollbackThread: () => unsupported("Local DeepSeek does not support rollback"),
              forkThread: () => unsupported("Local DeepSeek does not support thread forks"),
            } satisfies Adapter.ProviderAdapterV2SessionRuntime;
          }),
      });
    }),
};
