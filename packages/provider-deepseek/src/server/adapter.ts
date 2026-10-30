import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderTurnId as TurnId,
} from "@d4research/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
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
import { deepSeekCapabilities, niaDeepSeekCapabilities } from "./capabilities.ts";
import { runNiaTurn, type NiaMessage, type NiaToolEvent } from "./nia.ts";
import { makeNiaJournal, preferJournal } from "./niaJournal.ts";
import * as ProviderHost from "@d4research/provider-core/server/ProviderHost";
import { DeepSeekRequestError, requestCompletion, type ChatMessage } from "./http.ts";

const DRIVER = ProviderDriverKind.make("deepseek");
const isDeepSeekRequestError = Schema.is(DeepSeekRequestError);
export type DeepSeekAdapterV2DriverEnv = HttpClient.HttpClient | ProviderHost.ProviderHost;
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
      const journal = makeNiaJournal((yield* ProviderHost.ProviderHost).paths.stateDir);
      const mcpSessions = Option.getOrUndefined(
        yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions),
      );
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
            // MCP credential IDs and orchestration session IDs belong to separate namespaces.
            // Bind this runtime to the credential prepared before openSession, not a later replacement.
            const sessionRegistration = mcpSessions
              ? yield* mcpSessions.read(sessionInput.threadId)
              : undefined;
            const scope = yield* Effect.scope;
            const queue = yield* Effect.acquireRelease(
              Queue.unbounded<Adapter.ProviderAdapterV2Event>(),
              Queue.shutdown,
            );
            const niaHistory = new Map<ProviderThreadId, ReadonlyArray<NiaMessage>>();
            // Threads whose Nia history was rebuilt from visible messages rather than saved protocol.
            const derivedNiaHistory = new Set<ProviderThreadId>();
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
              capabilities:
                sessionInput.runtimePolicy.toolPolicy === "d4-agent"
                  ? niaDeepSeekCapabilities
                  : deepSeekCapabilities,
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
                  if (thread.nativeMetadata?.deepSeekNiaHistory)
                    niaHistory.set(thread.id, thread.nativeMetadata.deepSeekNiaHistory);
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
                  if (providerThread.nativeMetadata?.deepSeekNiaHistory)
                    niaHistory.set(
                      providerThread.id,
                      providerThread.nativeMetadata.deepSeekNiaHistory,
                    );
                  return providerThread;
                }),
              injectHistory: (input) =>
                Effect.sync(() => {
                  if (!niaHistory.has(input.providerThread.id)) {
                    const saved = input.providerThread.nativeMetadata?.deepSeekNiaHistory;
                    if (!saved) derivedNiaHistory.add(input.providerThread.id);
                    niaHistory.set(
                      input.providerThread.id,
                      saved ??
                        input.messages.map((message) => ({
                          role: message.role,
                          content: message.text,
                        })),
                    );
                  }
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
                  const isNia = input.runtimePolicy.toolPolicy === "d4-agent";
                  if (
                    (!isNia &&
                      (input.modelSelection.options?.find((option) => option.id === "taskMode")
                        ?.value ?? config.taskMode) === "tools") ||
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
                  if (isNia) {
                    // Only a missing journal reads as absent; anything else must not be overwritten.
                    const journaled = yield* Effect.tryPromise(() =>
                      journal.read(input.providerThread.id),
                    ).pipe(
                      Effect.mapError(
                        () =>
                          new Adapter.ProviderAdapterTurnStartError({
                            driver: DRIVER,
                            threadId: input.threadId,
                            providerThreadId: input.providerThread.id,
                            runId: input.runId,
                          }),
                      ),
                    );
                    const committed = niaHistory.get(input.providerThread.id);
                    // Visible messages lack the runtime context and tool pairs the loop saw, so
                    // they never outrank the journal; saved protocol history must be its prefix.
                    if (journaled)
                      niaHistory.set(
                        input.providerThread.id,
                        committed && !derivedNiaHistory.has(input.providerThread.id)
                          ? preferJournal(committed, journaled)
                          : journaled,
                      );
                  }
                  // Resume without authoritative history must fail rather than silently lose the conversation.
                  if (
                    (input.nativeThreadHasTurns || input.providerThread.lastRunOrdinal !== null) &&
                    !(isNia
                      ? niaHistory.has(input.providerThread.id)
                      : history.has(input.providerThread.id))
                  )
                    return yield* unsupported(
                      "Conversation history is required before continuing a local DeepSeek thread",
                    );
                  const registration =
                    isNia && mcpSessions ? yield* mcpSessions.read(input.threadId) : undefined;
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
                  let workingNiaHistory: NiaMessage[] = [
                    ...(niaHistory.get(input.providerThread.id) ?? []),
                    { role: "user", content: input.message.text },
                  ];
                  // Commit protocol history at every step so a crash or failed request cannot drop
                  // the admitted message or a completed tool call from later Nia turns.
                  // Snapshots carry the whole history, so an unchanged one is not re-sent.
                  let lastPersisted: string | undefined;
                  const persistNiaHistory = () => {
                    niaHistory.set(input.providerThread.id, workingNiaHistory);
                    const deepSeekNiaHistory = workingNiaHistory.flatMap((message) =>
                      message.role === "system" ? [] : [{ ...message, role: message.role }],
                    );
                    const serialized = JSON.stringify(deepSeekNiaHistory);
                    if (serialized === lastPersisted) return Promise.resolve();
                    lastPersisted = serialized;
                    const currentThread =
                      threads.get(input.providerThread.id) ?? input.providerThread;
                    const providerThread = {
                      ...currentThread,
                      updatedAt: DateTime.nowUnsafe(),
                      nativeMetadata: { ...currentThread.nativeMetadata, deepSeekNiaHistory },
                    };
                    threads.set(providerThread.id, providerThread);
                    Queue.offerUnsafe(queue, {
                      type: "provider_thread.updated",
                      driver: DRIVER,
                      providerThread,
                    });
                    return journal.write(input.providerThread.id, deepSeekNiaHistory);
                  };
                  if (isNia) {
                    yield* Effect.tryPromise(persistNiaHistory).pipe(
                      Effect.mapError(
                        () =>
                          new Adapter.ProviderAdapterTurnStartError({
                            driver: DRIVER,
                            threadId: input.threadId,
                            providerThreadId: input.providerThread.id,
                            runId: input.runId,
                          }),
                      ),
                    );
                    derivedNiaHistory.delete(input.providerThread.id);
                  }
                  let nextItemOrdinal = 1;
                  const toolStates = new Map<
                    string,
                    { event: NiaToolEvent; ordinal: number; startedAt: DateTime.Utc }
                  >();
                  const emitTool = (event: NiaToolEvent, closing = false) => {
                    if (finished && !closing) return;
                    // The loop has already saved its exact call through onHistory; only a
                    // completed result replaces the placeholder here.
                    if (event.phase === "completed" && event.result !== undefined) {
                      const last = workingNiaHistory.at(-1);
                      if (last?.role === "tool" && last.tool_call_id === event.callId) {
                        workingNiaHistory[workingNiaHistory.length - 1] = {
                          ...last,
                          content: event.result,
                        };
                      }
                    }
                    // The loop awaits this, so a result is on disk before the next model call.
                    const saved = persistNiaHistory();
                    const time = DateTime.nowUnsafe();
                    const existing = toolStates.get(event.callId);
                    const state = {
                      event,
                      ordinal: existing?.ordinal ?? nextItemOrdinal++,
                      startedAt: existing?.startedAt ?? time,
                    };
                    toolStates.set(event.callId, state);
                    const status =
                      event.phase === "started"
                        ? "running"
                        : event.phase === "interrupted"
                          ? "interrupted"
                          : event.phase === "failed" || event.isError
                            ? "failed"
                            : "completed";
                    const nodeId = NodeId.make(`${turnId}:tool:${event.callId}`);
                    const nativeItemRef = null;
                    Queue.offerUnsafe(queue, {
                      type: "node.updated",
                      driver: DRIVER,
                      node: {
                        id: nodeId,
                        threadId: input.threadId,
                        runId: input.runId,
                        parentNodeId: input.rootNodeId,
                        rootNodeId: input.rootNodeId,
                        kind: "tool_call",
                        status,
                        countsForRun: false,
                        providerThreadId: input.providerThread.id,
                        providerTurnId: turnId,
                        nativeItemRef,
                        runtimeRequestId: null,
                        checkpointScopeId: null,
                        startedAt: state.startedAt,
                        completedAt: status === "running" ? null : time,
                      },
                    });
                    Queue.offerUnsafe(queue, {
                      type: "turn_item.updated",
                      driver: DRIVER,
                      turnItem: {
                        id: TurnItemId.make(`${turnId}:tool:${event.callId}`),
                        threadId: input.threadId,
                        runId: input.runId,
                        nodeId,
                        providerThreadId: input.providerThread.id,
                        providerTurnId: turnId,
                        nativeItemRef,
                        parentItemId: null,
                        ordinal: state.ordinal,
                        status,
                        title: null,
                        startedAt: state.startedAt,
                        completedAt: status === "running" ? null : time,
                        updatedAt: time,
                        type: "dynamic_tool",
                        toolName: event.name,
                        input: event.arguments ?? existing?.event.arguments ?? {},
                        ...(event.result === undefined ? {} : { output: event.result }),
                      },
                    });
                    return saved;
                  };
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
                  let finished = false;
                  const finish = (status: "completed" | "interrupted" | "failed", code?: string) =>
                    Effect.gen(function* () {
                      if (finished) return;
                      finished = true;
                      const completedAt = yield* DateTime.now;
                      for (const { event } of toolStates.values()) {
                        if (event.phase === "started")
                          emitTool(
                            {
                              ...event,
                              phase: status === "interrupted" ? "interrupted" : "failed",
                              isError: true,
                            },
                            true,
                          )?.catch(() => {});
                      }
                      if (isNia) yield* Effect.promise(() => persistNiaHistory().catch(() => {}));
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
                          failureItemOrdinal: nextItemOrdinal,
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
                    }).pipe(Effect.uninterruptible);
                  const work = Effect.gen(function* () {
                    const result = yield* isNia
                      ? Effect.tryPromise({
                          try: (signal) => {
                            if (
                              !registration ||
                              registration.providerInstanceId !== instanceId ||
                              registration.threadId !== sessionInput.threadId ||
                              input.threadId !== sessionInput.threadId ||
                              input.providerThread.providerInstanceId !== instanceId ||
                              input.providerThread.providerSessionId !==
                                sessionInput.providerSessionId ||
                              registration.providerSessionId !==
                                sessionRegistration?.providerSessionId
                            )
                              throw new DeepSeekRequestError({ category: "configuration" });
                            return runNiaTurn(
                              config,
                              workingNiaHistory,
                              {
                                endpoint: registration.endpoint,
                                headers: { Authorization: registration.authorizationHeader },
                              },
                              emitTool,
                              signal,
                              (nextHistory) => {
                                if (!finished) {
                                  workingNiaHistory = nextHistory.filter(
                                    (message) => message.role !== "system",
                                  );
                                  return persistNiaHistory();
                                }
                              },
                              (usage) => {
                                if (finished) return;
                                turn = {
                                  ...turn,
                                  tokenUsage: {
                                    usedTokens: usage.total_tokens,
                                    maxTokens: config.contextWindowTokens,
                                    inputTokens: usage.prompt_tokens,
                                    outputTokens: usage.completion_tokens,
                                    updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                                  },
                                };
                                Queue.offerUnsafe(queue, {
                                  type: "provider_turn.updated",
                                  driver: DRIVER,
                                  threadId: input.threadId,
                                  providerTurn: turn,
                                });
                              },
                            );
                          },
                          catch: (cause) =>
                            isDeepSeekRequestError(cause)
                              ? cause
                              : new DeepSeekRequestError({ category: "transport", cause }),
                        })
                      : requestCompletion(client, config, requestMessages);
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
                        ordinal: nextItemOrdinal++,
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
                  providerThread: threads.get(providerThread.id) ?? providerThread,
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
