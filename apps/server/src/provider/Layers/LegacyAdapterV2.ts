import {
  ApprovalRequestId,
  MessageId,
  PlanId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type TurnId,
} from "@d4research/contracts";
import { DateTime, Effect, PubSub, Schema, Stream } from "effect";
import * as V2 from "../../orchestration-v2/ProviderAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.toType(V2.ProviderAdapterV2Event));
const decodeCursor = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Keep the native adapters as protocol owners while translating their event boundary. */
export function legacyAdapterCapabilities(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): OrchestrationV2ProviderCapabilities {
  const interactive = adapter.provider !== "agy";
  return {
    sessions: {
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: adapter.capabilities.sessionModelSwitch === "in-session",
      supportsProviderSwitchingViaHandoff: true,
      supportsRuntimeModeSwitchInSession: false,
      pendingRequestsSurviveRestart: false,
    },
    threads: {
      canCreateEmptyThread: true,
      canReadThreadSnapshot: false,
      canRollbackThread: false,
      canForkThread: false,
      canForkFromTurn: false,
      canForkFromSubagentThread: false,
      exposesNativeThreadId: true,
    },
    turns: {
      exposesNativeTurnId: false,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: false,
      supportsQueuedMessages: true,
      terminalStatusQuality: "strong",
    },
    streaming: {
      streamsAssistantText: true,
      streamsReasoning: interactive,
      streamsToolOutput: interactive,
      streamsPlanText: interactive,
      emitsMessageCompleted: true,
    },
    tools: {
      exposesToolItemIds: interactive,
      emitsToolStarted: interactive,
      emitsToolCompleted: interactive,
      emitsToolOutput: interactive,
      supportsMcpTools: interactive,
      supportsDynamicToolCallbacks: false,
    },
    approvals: {
      supportsCommandApproval: interactive,
      supportsFileReadApproval: interactive,
      supportsFileChangeApproval: interactive,
      supportsApplyPatchApproval: interactive,
      approvalsHaveNativeRequestIds: interactive,
      approvalCallbacksAreLiveOnly: true,
      approvalsCanOriginateFromSubagents: false,
    },
    planning: {
      emitsPlanUpdated: interactive,
      emitsTodoList: interactive,
      emitsProposedPlan: interactive,
      supportsStructuredQuestions: interactive,
      planDeltasHaveItemIds: false,
    },
    subagents: {
      supportsSubagents: false,
      exposesSubagentThreadIds: false,
      emitsSubagentLifecycle: false,
      canWaitForSubagents: false,
      canCloseSubagents: false,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: false,
      acceptsDeveloperContext: false,
      acceptsSyntheticUserContext: true,
      canGenerateSummaries: false,
      canConsumeHandoffSummaries: true,
      supportsDeltaHandoff: true,
      supportsFullThreadHandoff: true,
      maxRecommendedHandoffChars: adapter.provider === "agy" ? 96000 : null,
    },
    checkpointing: {
      appCanCheckpointFilesystem: true,
      supportsNestedCheckpointScopes: false,
      providerCanRollbackConversation: false,
      providerRollbackReturnsSnapshot: false,
      providerCanReadConversationSnapshot: false,
    },
    identity: {
      nativeThreadIds: "weak",
      nativeTurnIds: "weak",
      nativeItemIds: "weak",
      nativeRequestIds: "strong",
    },
    runtimePolicy: { enforcement: adapter.provider === "junie" ? "client-boundary" : "native" },
  };
}

function requestKind(type: string) {
  if (type === "file_read_approval") return "file-read";
  if (type === "file_change_approval" || type === "apply_patch_approval") return "file-change";
  if (type === "mcp_elicitation_approval") return "mcp-elicitation";
  if (type === "permission_approval") return "permission";
  return "command";
}

/** Each run owns its ordinals and accumulated deltas; native item ids remain stable. */
export function makeLegacyTurnTranslator(
  input: Pick<
    V2.ProviderAdapterV2TurnInput,
    | "threadId"
    | "runId"
    | "attemptId"
    | "rootNodeId"
    | "providerThread"
    | "runOrdinal"
    | "providerTurnOrdinal"
  >,
  driver: ProviderAdapterShape<ProviderAdapterError>["provider"],
) {
  const providerTurnId = ProviderTurnId.make(`${input.providerThread.id}:${input.attemptId}`);
  let ordinal = 0;
  let terminal = false;
  const items = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const ref = (nativeId: string) => ({ driver, nativeId, strength: "weak" });
  const emit = (type: string, value: Record<string, unknown>) =>
    decodeEvent({ type, driver, ...value });
  const base = (key: string, event: ProviderRuntimeEvent) => {
    const previous = items.get(key);
    const now = DateTime.makeUnsafe(event.createdAt);
    return (
      previous ?? {
        id: TurnItemId.make(`${providerTurnId}:${key}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        providerThreadId: input.providerThread.id,
        providerTurnId,
        nativeItemRef: event.itemId ? ref(event.itemId) : null,
        parentItemId: null,
        ordinal: ++ordinal,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      }
    );
  };
  const save = (key: string, event: ProviderRuntimeEvent, fields: Record<string, unknown>) => {
    const item = {
      ...base(key, event),
      ...fields,
      updatedAt: DateTime.makeUnsafe(event.createdAt),
    };
    items.set(key, item);
    return emit("turn_item.updated", { turnItem: item });
  };
  const translate = (event: ProviderRuntimeEvent): Array<V2.ProviderAdapterV2Event> => {
    if (terminal) return [];
    const now = DateTime.makeUnsafe(event.createdAt);
    const key = event.itemId ?? event.providerRefs?.providerItemId ?? event.type;
    switch (event.type) {
      case "turn.started":
        return [
          emit("provider_turn.updated", {
            threadId: input.threadId,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: input.providerThread.id,
              nodeId: input.rootNodeId,
              runAttemptId: input.attemptId,
              nativeTurnRef: event.turnId ? ref(event.turnId) : null,
              ordinal: input.providerTurnOrdinal,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          }),
        ];
      case "content.delta": {
        const assistant = event.payload.streamKind === "assistant_text";
        const reasoning = event.payload.streamKind.includes("reasoning");
        const previous = items.get(key);
        if (assistant || reasoning)
          return [
            save(key, event, {
              type: assistant ? "assistant_message" : "reasoning",
              ...(assistant ? { messageId: MessageId.make(`${providerTurnId}:${key}`) } : {}),
              text: String(previous?.text ?? "") + event.payload.delta,
              streaming: true,
            }),
          ];
        return [
          save(key, event, {
            type: "dynamic_tool",
            toolName: event.payload.streamKind,
            output: String(previous?.output ?? "") + event.payload.delta,
          }),
        ];
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const previous = items.get(key);
        const completed = event.type === "item.completed";
        const status =
          event.payload.status === "failed"
            ? "failed"
            : event.payload.status === "declined"
              ? "cancelled"
              : completed
                ? "completed"
                : "running";
        const textItem =
          event.payload.itemType === "assistant_message" || event.payload.itemType === "reasoning";
        const body = textItem
          ? {
              type: event.payload.itemType,
              ...(event.payload.itemType === "assistant_message"
                ? { messageId: MessageId.make(`${providerTurnId}:${key}`) }
                : {}),
              text: event.payload.detail ?? previous?.text ?? "",
              streaming: !completed,
            }
          : {
              type: "dynamic_tool",
              toolName: event.payload.title ?? event.payload.itemType,
              output: event.payload.data ?? event.payload.detail,
              toolSurface: event.payload.toolSurface,
              toolIcon: event.payload.toolIcon,
              toolSource: event.payload.toolSource,
            };
        return [
          save(key, event, {
            ...body,
            title: event.payload.title ?? previous?.title ?? null,
            status,
            completedAt: completed ? now : null,
          }),
        ];
      }
      case "request.opened":
      case "user-input.requested": {
        if (!event.requestId) return [];
        const kind =
          event.type === "user-input.requested"
            ? "user_input"
            : requestKind(event.payload.requestType);
        const request = {
          id: event.requestId,
          nodeId: input.rootNodeId,
          providerTurnId,
          nativeRequestRef: {
            ...ref(event.providerRefs?.providerRequestId ?? event.requestId),
            strength: "strong",
          },
          kind,
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: input.providerThread.providerSessionId,
          },
          createdAt: now,
          resolvedAt: null,
        };
        requests.set(event.requestId, request);
        return [
          emit("runtime_request.updated", { threadId: input.threadId, runtimeRequest: request }),
          save(
            `request:${event.requestId}`,
            event,
            event.type === "user-input.requested"
              ? {
                  type: "user_input_request",
                  requestId: event.requestId,
                  questions: event.payload.questions,
                  responseMode: event.payload.responseMode,
                  status: "waiting",
                }
              : {
                  type: "approval_request",
                  requestId: event.requestId,
                  requestKind: kind,
                  prompt: event.payload.detail,
                  appName: event.payload.appName,
                  options: event.payload.options,
                  status: "waiting",
                },
          ),
        ];
      }
      case "request.resolved":
      case "user-input.resolved": {
        if (!event.requestId) return [];
        const previous = requests.get(event.requestId);
        if (!previous) return [];
        return [
          emit("runtime_request.updated", {
            threadId: input.threadId,
            runtimeRequest: { ...previous, status: "resolved", resolvedAt: now },
          }),
          save(`request:${event.requestId}`, event, { status: "completed", completedAt: now }),
        ];
      }
      case "turn.plan.updated":
        return [
          save("plan", event, {
            type: "todo_list",
            planId: PlanId.make(`${providerTurnId}:todo`),
            steps: event.payload.plan.map((step, index) => ({
              id: String(index),
              text: step.step,
              status: step.status === "inProgress" ? "running" : step.status,
            })),
            explanation: event.payload.explanation ?? undefined,
          }),
        ];
      case "turn.proposed.delta":
        return [
          save("proposed-plan", event, {
            type: "proposed_plan",
            planId: PlanId.make(`${providerTurnId}:plan`),
            markdown: String(items.get("proposed-plan")?.markdown ?? "") + event.payload.delta,
            streaming: true,
          }),
        ];
      case "turn.proposed.completed":
        return [
          save("proposed-plan", event, {
            type: "proposed_plan",
            planId: PlanId.make(`${providerTurnId}:plan`),
            markdown: event.payload.planMarkdown,
            streaming: false,
            status: "completed",
            completedAt: now,
          }),
        ];
      case "turn.completed":
      case "turn.aborted": {
        terminal = true;
        const status = event.type === "turn.aborted" ? "interrupted" : event.payload.state;
        const result: Array<V2.ProviderAdapterV2Event> = [];
        for (const [itemKey, item] of items) {
          if (item.streaming === true)
            result.push(
              save(itemKey, event, {
                streaming: false,
                status: status === "failed" ? "failed" : "completed",
                completedAt: now,
              }),
            );
        }
        result.push(
          emit("provider_turn.updated", {
            threadId: input.threadId,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: input.providerThread.id,
              nodeId: input.rootNodeId,
              runAttemptId: input.attemptId,
              nativeTurnRef: event.turnId ? ref(event.turnId) : null,
              ordinal: input.providerTurnOrdinal,
              status,
              startedAt: null,
              completedAt: now,
              ...(event.payload.tokenUsage ? { turnTokenUsage: event.payload.tokenUsage } : {}),
            },
          }),
        );
        result.push(
          emit("turn.terminal", {
            providerThreadId: input.providerThread.id,
            providerTurnId,
            runOrdinal: input.runOrdinal,
            status,
            failure:
              status === "failed"
                ? {
                    class: "provider_error",
                    message:
                      event.type === "turn.completed"
                        ? (event.payload.errorMessage ?? "Provider turn failed.")
                        : "Provider turn interrupted.",
                    code: null,
                    retryable: null,
                  }
                : null,
            ...(status === "failed" ? { failureItemOrdinal: ++ordinal } : {}),
            threadDisposition: "reusable",
          }),
        );
        return result;
      }
      case "runtime.warning":
      case "runtime.error":
        return [
          save(key, event, {
            type: "system_notice",
            message: event.payload.message,
            status: event.type === "runtime.error" ? "failed" : "completed",
            completedAt: now,
          }),
        ];
      default:
        return [];
    }
  };
  const convert = (event: ProviderRuntimeEvent) =>
    translate(event).flatMap((value) => {
      if (value.type !== "turn_item.updated" || value.turnItem.type !== "assistant_message")
        return [value];
      const item = value.turnItem;
      return [
        emit("message.updated", {
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: item.messageId,
            threadId: item.threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            role: "assistant",
            text: item.text,
            attachments: [],
            streaming: item.streaming,
            createdAt: item.startedAt ?? item.updatedAt,
            updatedAt: item.updatedAt,
          },
        }),
        value,
      ];
    });
  return { convert, providerTurnId, requests };
}

export function makeLegacyAdapterV2(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  instanceId: ProviderInstanceId,
): V2.ProviderAdapterV2Shape {
  const driver = adapter.provider;
  const capabilities = legacyAdapterCapabilities(adapter);
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: (input) =>
      Effect.succeed(
        input.current.model === input.target.model ||
          capabilities.sessions.supportsModelSwitchInSession
          ? { type: "apply_on_next_turn" }
          : { type: "restart_session" },
      ),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providerSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready" as const,
          cwd: input.runtimePolicy.cwd ?? ".",
          model: input.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const scope = yield* Effect.scope;
        const events = yield* PubSub.unbounded<
          V2.ProviderAdapterV2Event | V2.ProviderAdapterV2Error
        >();
        let thread: OrchestrationV2ProviderThread | undefined;
        let translator: ReturnType<typeof makeLegacyTurnTranslator> | undefined;
        let nativeTurnId: TurnId | undefined;
        const publish = (event: V2.ProviderAdapterV2Event) =>
          PubSub.publish(events, event).pipe(Effect.asVoid);
        const protocol = (cause: unknown) =>
          new V2.ProviderAdapterProtocolError({
            driver,
            detail: "Legacy provider event translation failed",
            cause,
          });
        const updateCursor = (session: Pick<ProviderSession, "resumeCursor">) =>
          Effect.gen(function* () {
            if (!thread || session.resumeCursor === undefined) return;
            thread = {
              ...thread,
              nativeThreadRef: {
                driver,
                nativeId: encodeCursor(session.resumeCursor),
                strength: "weak",
              },
              updatedAt: yield* DateTime.now,
            };
            yield* publish({ type: "provider_thread.updated", driver, providerThread: thread });
          });
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === input.threadId),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.turnId) nativeTurnId = event.turnId;
              if (event.type === "session.state.changed") {
                yield* publish({
                  type: "provider_session.updated",
                  driver,
                  providerSession: {
                    ...providerSession,
                    status: event.payload.state,
                    updatedAt: DateTime.makeUnsafe(event.createdAt),
                    lastError:
                      event.payload.state === "error"
                        ? (event.payload.reason ?? "Provider session failed.")
                        : null,
                  },
                });
              }
              if (event.type === "thread.token-usage.updated" && thread) {
                thread = {
                  ...thread,
                  contextUsage: event.payload.usage,
                  updatedAt: DateTime.makeUnsafe(event.createdAt),
                };
                yield* publish({ type: "provider_thread.updated", driver, providerThread: thread });
              }
              if (event.type === "turn.completed" || event.type === "session.started") {
                const sessions = yield* adapter.listSessions();
                const native = sessions.find((session) => session.threadId === input.threadId);
                if (native) yield* updateCursor(native);
              }
              const translated = yield* Effect.try({
                try: () => translator?.convert(event) ?? [],
                catch: protocol,
              });
              yield* Effect.forEach(translated, publish, { discard: true });
            }),
          ),
          Effect.catch((error) => PubSub.publish(events, error)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.addFinalizer(() => adapter.stopSession(input.threadId).pipe(Effect.ignore));
        const ensureThread: V2.ProviderAdapterV2SessionRuntime["ensureThread"] = (args) =>
          Effect.gen(function* () {
            if (thread) return thread;
            if (
              ["agy", "muse", "junie"].includes(driver) &&
              Schema.is(Schema.Struct({ type: Schema.Literal("readOnly") }))(
                args.runtimePolicy.sandboxPolicy,
              )
            ) {
              return yield* new V2.ProviderAdapterEnsureThreadError({
                driver,
                threadId: input.threadId,
                cause: "This native adapter cannot enforce an advisory read-only sandbox.",
              });
            }
            const resumeCursor = args.existingProviderThread?.nativeThreadRef?.nativeId;
            const cursor = resumeCursor
              ? yield* Effect.try({ try: () => decodeCursor(resumeCursor), catch: protocol })
              : undefined;
            const native = yield* adapter
              .startSession({
                threadId: input.threadId,
                provider: driver,
                providerInstanceId: instanceId,
                cwd: args.runtimePolicy.cwd ?? undefined,
                modelSelection: args.modelSelection,
                runtimeMode: args.runtimePolicy.runtimeMode,
                ...(Schema.is(Schema.Struct({ type: Schema.Literal("readOnly") }))(
                  args.runtimePolicy.sandboxPolicy,
                )
                  ? { sandboxMode: "read-only" as const }
                  : {}),
                ...(cursor === undefined ? {} : { resumeCursor: cursor }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new V2.ProviderAdapterEnsureThreadError({
                      driver,
                      threadId: input.threadId,
                      cause,
                    }),
                ),
              );
            thread = {
              id:
                args.existingProviderThread?.id ??
                ProviderThreadId.make(`${instanceId}:${input.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: args.existingProviderThread?.firstRunOrdinal ?? null,
              lastRunOrdinal: args.existingProviderThread?.lastRunOrdinal ?? null,
              handoffIds: args.existingProviderThread?.handoffIds ?? [],
              forkedFrom: args.existingProviderThread?.forkedFrom ?? null,
              createdAt: args.existingProviderThread?.createdAt ?? now,
              updatedAt: yield* DateTime.now,
            };
            yield* updateCursor(native);
            return thread;
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events).pipe(
            Stream.mapEffect((event) =>
              Schema.is(V2.ProviderAdapterV2Error)(event)
                ? Effect.fail(event)
                : Effect.succeed(event),
            ),
          ),
          ensureThread,
          resumeThread: (args) =>
            ensureThread({
              threadId: input.threadId,
              modelSelection: args.modelSelection ?? input.modelSelection,
              runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: args.providerThread,
            }),
          startTurn: (args) =>
            Effect.gen(function* () {
              translator = makeLegacyTurnTranslator(args, driver);
              nativeTurnId = undefined;
              const send = adapter
                .sendTurn({
                  threadId: input.threadId,
                  input: args.message.text,
                  attachments: args.message.attachments,
                  modelSelection: args.modelSelection,
                  interactionMode: args.runtimePolicy.interactionMode,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new V2.ProviderAdapterTurnStartError({
                        driver,
                        threadId: input.threadId,
                        providerThreadId: args.providerThread.id,
                        runId: args.runId,
                        cause,
                      }),
                  ),
                  Effect.flatMap((result) => {
                    nativeTurnId = result.turnId;
                    return updateCursor(result);
                  }),
                );
              if (adapter.capabilities.turnSendResolvesAtCompletion) {
                yield* send.pipe(
                  Effect.catch((error) => PubSub.publish(events, error)),
                  Effect.forkIn(scope, { startImmediately: true }),
                );
              } else {
                yield* send;
              }
            }),
          steerTurn: (args) =>
            Effect.fail(
              new V2.ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: args.providerThread.id,
              }),
            ),
          interruptTurn: (args) =>
            adapter.interruptTurn(input.threadId, nativeTurnId).pipe(
              Effect.mapError(
                (cause) =>
                  new V2.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: args.providerThread.id,
                    providerTurnId: args.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (args) =>
            Effect.suspend(
              (): Effect.Effect<
                void,
                ProviderAdapterError | V2.ProviderAdapterRuntimeRequestResponseError
              > =>
                args.answers
                  ? adapter.respondToUserInput(
                      input.threadId,
                      ApprovalRequestId.make(args.requestId),
                      args.answers,
                    )
                  : args.decision
                    ? adapter.respondToRequest(
                        input.threadId,
                        ApprovalRequestId.make(args.requestId),
                        args.decision,
                      )
                    : Effect.fail(
                        new V2.ProviderAdapterRuntimeRequestResponseError({
                          driver,
                          requestId: args.requestId,
                        }),
                      ),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new V2.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: args.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: (args) =>
            Effect.fail(
              new V2.ProviderAdapterReadThreadSnapshotError({
                driver,
                providerThreadId: args.providerThread.id,
                cause: "The native adapter does not expose a V2 conversation snapshot.",
              }),
            ),
          rollbackThread: (args) =>
            Effect.fail(
              new V2.ProviderAdapterRollbackThreadError({
                driver,
                providerThreadId: args.providerThread.id,
                cause: "The native adapter does not support conversation rollback.",
              }),
            ),
          forkThread: (args) =>
            Effect.fail(
              new V2.ProviderAdapterForkThreadError({
                driver,
                providerThreadId: args.sourceProviderThread.id,
                cause: "The native adapter does not support conversation forks.",
              }),
            ),
        } satisfies V2.ProviderAdapterV2SessionRuntime;
      }),
  };
}
