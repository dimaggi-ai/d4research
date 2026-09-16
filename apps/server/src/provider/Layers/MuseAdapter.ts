import {
  ProviderItemId,
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  MUSE_REASONING_EFFORTS,
  type MuseSettings,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@d4research/contracts";
import {
  Cause,
  Crypto,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@d4research/shared/model";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { MuseAdapterShape } from "../Services/MuseAdapter.ts";
import { makeMuseMspRuntime, type MuseMspRuntime } from "../msp/MspSessionRuntime.ts";
import { MspRpcError } from "../msp/MspConnection.ts";
import * as Msp from "../msp/MspProtocol.ts";
import {
  approvalOptionsFromChoices,
  requestTypeForSubject,
  selectChoiceForDecision,
  shouldAutoDecide,
} from "../msp/museApprovalMode.ts";
import { mspNotificationToRuntimeEvents } from "../msp/museRuntimeEvents.ts";
import { patchBodyToUnifiedDiff } from "../msp/musePatchDiff.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  viewCursor: Schema.String,
});
const isMspRpcError = Schema.is(MspRpcError);
const decodeApproval = Schema.decodeUnknownEffect(Msp.ApprovalRequestParams);
const decodeUserInput = Schema.decodeUnknownEffect(Msp.UserInputRequestParams);
const decodeResumeCursor = Schema.decodeUnknownEffect(ResumeCursor);
const decodeDecisionAck = Schema.decodeUnknownEffect(
  Schema.Struct({ terminal: Schema.optionalKey(Schema.Boolean) }),
);
interface MuseContext {
  session: ProviderSession;
  runtime: MuseMspRuntime;
  queue: Queue.Queue<Incoming>;
  sessionId: string;
  viewCursor: string;
  activeTurnId: TurnId | undefined;
  /** Sandbox posture of the running host: plan hosts are read-only. */
  interactionMode: ProviderInteractionMode;
  /**
   * Host generation. Plan-mode respawns stop the old host, whose `ended`
   * watcher must not stop the context: only the current generation may do
   * that.
   */
  hostGeneration: number;
  readonly pendingApprovals: Map<ApprovalRequestId, Msp.ApprovalRequestParams>;
  readonly pendingUserInputs: Map<ApprovalRequestId, Msp.UserInputRequestParams>;
  readonly items: Map<string, Msp.Item>;
  readonly scope: Scope.Closeable;
  stopped: boolean;
  reserved: boolean;
  contextUsage: Msp.SessionContextUsageParams | undefined;
}
type Incoming =
  | { method: string; params: unknown; request: boolean; generation: number }
  | {
      exited: true;
    };
export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  settings: MuseSettings,
  options?: {
    environment?: NodeJS.ProcessEnv;
    nativeEventLogger?: EventNdjsonLogger;
    instanceId?: ProviderInstanceId;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("muse");
  const sessions = new Map<ThreadId, MuseContext>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const boot = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  let sequence = 0;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const stamp = (threadId: ThreadId) =>
    Effect.gen(function* () {
      return {
        eventId: EventId.make(`muse-${boot}-${++sequence}`),
        createdAt: yield* now,
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId,
      };
    });
  const offer = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const warning = (threadId: ThreadId, message: string) =>
    Effect.gen(function* () {
      yield* offer({ ...(yield* stamp(threadId)), type: "runtime.warning", payload: { message } });
    });
  const mapError = (method: string) => (cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail:
        isMspRpcError(cause) && cause.data?.kind === "sessionInUse"
          ? "Muse session is open in another client"
          : cause instanceof Error
            ? cause.message
            : String(cause),
      cause,
    });
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<MuseContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const updateCursor = (ctx: MuseContext, cursor: string) => {
    ctx.viewCursor = cursor;
    ctx.session = {
      ...ctx.session,
      resumeCursor: { schemaVersion: 1, sessionId: ctx.sessionId, viewCursor: cursor },
    };
  };
  const resolveApproval = Effect.fn("MuseAdapter.resolveApproval")(function* (
    ctx: MuseContext,
    id: ApprovalRequestId,
    decision: string,
  ) {
    const pending = ctx.pendingApprovals.get(id);
    if (!pending) return;
    ctx.pendingApprovals.delete(id);
    yield* offer({
      ...(yield* stamp(ctx.session.threadId)),
      type: "request.resolved",
      requestId: RuntimeRequestId.make(id),
      turnId: TurnId.make(pending.turnId),
      providerRefs: { providerRequestId: pending.approvalId },
      payload: {
        requestType: requestTypeForSubject(pending.subject, pending.protectedWrite),
        decision,
      },
    });
  });
  const resolveInput = Effect.fn("MuseAdapter.resolveInput")(function* (
    ctx: MuseContext,
    id: ApprovalRequestId,
    answers: Record<string, unknown>,
  ) {
    const pending = ctx.pendingUserInputs.get(id);
    if (!pending) return;
    ctx.pendingUserInputs.delete(id);
    yield* offer({
      ...(yield* stamp(ctx.session.threadId)),
      type: "user-input.resolved",
      requestId: RuntimeRequestId.make(id),
      turnId: TurnId.make(pending.turnId),
      providerRefs: { providerRequestId: pending.userInputId },
      payload: { answers },
    });
  });
  const decide = Effect.fn("MuseAdapter.decide")(function* (
    ctx: MuseContext,
    id: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    const pending = ctx.pendingApprovals.get(id);
    if (!pending) return yield* mapError("approval/decide")("Muse approval is no longer pending.");
    const choice = selectChoiceForDecision(pending.availableChoices, decision);
    if (!choice)
      return yield* mapError("approval/decide")("Muse did not offer this approval decision.");
    const result = yield* ctx.runtime
      .decideApproval(ctx.sessionId, {
        approvalId: pending.approvalId,
        choiceId: choice.choiceId,
        requirementId: pending.currentRequirementId,
        ...(choice.acceptsFeedback && (decision === "decline" || decision === "cancel")
          ? { feedback: "Declined by the user in T3 Code." }
          : {}),
      })
      .pipe(
        Effect.catchTag("MspRpcError", (error) =>
          error.data?.kind === "approvalRequirementStale"
            ? warning(
                ctx.session.threadId,
                "Muse approval requirements changed; the previous request is no longer valid.",
              ).pipe(Effect.andThen(resolveApproval(ctx, id, "cancel")))
            : Effect.fail(error),
        ),
        Effect.mapError(mapError("approval/decide")),
      );
    const ack = yield* decodeDecisionAck(result ?? {}).pipe(
      Effect.mapError(mapError("approval/decide")),
    );
    if (ack.terminal !== false) yield* resolveApproval(ctx, id, decision);
  });
  // Fetches the stored structured patch behind an edit-family toolCall item
  // and emits it as a unified diff. Runs on its own fiber so a slow
  // `item/readOutput` never blocks the notification stream; failures only
  // warn, since the item itself was already emitted without the diff.
  const fetchPatchDiff = (ctx: MuseContext, item: Msp.Item): Effect.Effect<void> =>
    Effect.gen(function* () {
      const runtime = ctx.runtime;
      const sessionId = ctx.sessionId;
      const threadId = ctx.session.threadId;
      const ref = item.patchRef;
      if (!ref) return;
      const providerTurnId =
        typeof item.turnId === "string" && item.turnId.length > 0 ? item.turnId : ctx.activeTurnId;
      const turnId = providerTurnId ? TurnId.make(providerTurnId) : undefined;
      const tool = item.tool ?? "edit";
      const page = yield* runtime
        .readOutput({ sessionId, itemId: item.itemId, outputRef: ref.id })
        .pipe(
          Effect.catchCause((cause) =>
            warning(threadId, `Muse patch for ${tool} is unavailable: ${Cause.pretty(cause)}`).pipe(
              Effect.as(undefined),
            ),
          ),
        );
      if (page === undefined) return;
      const parsed = yield* decodeJsonUnknown(page.content).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (parsed === undefined) {
        yield* warning(threadId, `Muse patch for ${tool} is not valid JSON.`);
        return;
      }
      const diff = patchBodyToUnifiedDiff(parsed, ctx.session.cwd ?? ".");
      if (!diff) {
        yield* warning(threadId, `Muse patch for ${tool} has no file changes.`);
        return;
      }
      yield* offer({
        ...(yield* stamp(threadId)),
        type: "turn.diff.updated",
        ...(turnId ? { turnId } : {}),
        providerRefs: providerTurnId === undefined ? {} : { providerTurnId },
        raw: { source: "muse.msp.notification" as const, method: "item/completed", payload: item },
        payload: { unifiedDiff: diff },
      });
    });
  const processIncoming = Effect.fn("MuseAdapter.processIncoming")(function* (
    ctx: MuseContext,
    incoming: Incoming,
  ): Effect.fn.Return<void, Schema.SchemaError | ProviderAdapterRequestError> {
    if (ctx.stopped) return;
    if ("exited" in incoming) {
      ctx.stopped = true;
      ctx.session = { ...ctx.session, status: "error" };
      for (const id of ctx.pendingApprovals.keys()) yield* resolveApproval(ctx, id, "cancel");
      for (const id of ctx.pendingUserInputs.keys()) yield* resolveInput(ctx, id, {});
      yield* offer({
        ...(yield* stamp(ctx.session.threadId)),
        type: "session.exited",
        payload: {
          reason: ctx.runtime.stderr().trim() || "Muse process exited.",
          recoverable: false,
          exitKind: "error",
        },
      });
      yield* ctx.runtime.stop;
      return;
    }
    if (incoming.request) {
      if (incoming.method === "approval/request") {
        const p = yield* decodeApproval(incoming.params);
        if (p.sessionId !== ctx.sessionId) return;
        updateCursor(ctx, p.viewCursor);
        const old = [...ctx.pendingApprovals].find(
          ([, value]) => value.approvalId === p.approvalId,
        );
        if (old) yield* resolveApproval(ctx, old[0], "cancel");
        const id = ApprovalRequestId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
        ctx.pendingApprovals.set(id, p);
        const auto = p.availableChoices.find((choice) =>
          ["approved", "approvedForSession", "approvedPolicyAmendment"].includes(choice.decision),
        );
        if (shouldAutoDecide(ctx.session.runtimeMode, p) && auto) {
          const decision = approvalOptionsFromChoices([auto])[0]?.decision;
          if (decision) {
            yield* decide(ctx, id, decision);
            return;
          }
        }
        yield* offer({
          ...(yield* stamp(ctx.session.threadId)),
          type: "request.opened",
          requestId: RuntimeRequestId.make(id),
          itemId: RuntimeItemId.make(p.itemId),
          turnId: TurnId.make(p.turnId),
          providerRefs: {
            providerRequestId: p.approvalId,
            providerItemId: ProviderItemId.make(p.itemId),
            providerTurnId: p.turnId,
          },
          raw: { source: "muse.msp.request", method: incoming.method, payload: p },
          payload: {
            requestType: requestTypeForSubject(p.subject, p.protectedWrite),
            detail: p.subject.command ?? p.subject.path ?? p.toolName,
            args: p.rawArgs,
            options: approvalOptionsFromChoices(p.availableChoices),
          },
        });
      } else if (incoming.method === "userInput/request") {
        const p = yield* decodeUserInput(incoming.params);
        if (p.sessionId !== ctx.sessionId) return;
        if (
          [...ctx.pendingUserInputs.values()].some((value) => value.userInputId === p.userInputId)
        )
          return;
        const id = ApprovalRequestId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
        ctx.pendingUserInputs.set(id, p);
        yield* offer({
          ...(yield* stamp(ctx.session.threadId)),
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(id),
          turnId: TurnId.make(p.turnId),
          itemId: RuntimeItemId.make(p.itemId),
          providerRefs: {
            providerRequestId: p.userInputId,
            providerItemId: ProviderItemId.make(p.itemId),
            providerTurnId: p.turnId,
          },
          raw: { source: "muse.msp.request", method: incoming.method, payload: p },
          payload: {
            questions: p.questions.map((q) => ({
              id: q.id,
              header: q.header,
              question: q.question,
              options: q.options.map((o) => ({
                label: o.label,
                description: o.description ?? "",
                value: o.label,
              })),
              allowCustomAnswer: false,
              multiSelect: q.selection.mode === "multiple",
            })),
          },
        });
      }
      return;
    }
    const notification = yield* Effect.try({
      try: () => Msp.decodeMspNotification(incoming.method, incoming.params),
      catch: mapError(incoming.method),
    });
    if (!notification || notification.params.sessionId !== ctx.sessionId) return;
    const p = notification.params;
    if ("viewCursor" in p && p.viewCursor) updateCursor(ctx, p.viewCursor);
    if ("item" in p) ctx.items.set(p.item.itemId, p.item);
    if (notification.method === "item/completed") {
      const finished = notification.params.item;
      if (
        finished.kind === "toolCall" &&
        finished.patchRef &&
        (finished.patchRef.availability === undefined ||
          finished.patchRef.availability === "available")
      )
        yield* fetchPatchDiff(ctx, finished).pipe(Effect.forkIn(ctx.scope));
    }
    if (notification.method === "approval/updated") {
      const updated = notification.params;
      const pending = [...ctx.pendingApprovals.values()].find(
        (value) => value.approvalId === updated.approvalId,
      );
      if (pending)
        yield* processIncoming(ctx, {
          method: "approval/request",
          request: true,
          generation: ctx.hostGeneration,
          params: { ...pending, ...updated },
        });
      return;
    }
    if (notification.method === "session/modelChanged")
      ctx.session = { ...ctx.session, model: notification.params.modelId };
    if (notification.method === "approval/resolved") {
      for (const [id, pending] of ctx.pendingApprovals)
        if (pending.approvalId === notification.params.approvalId)
          yield* resolveApproval(ctx, id, notification.params.decision);
      return;
    }
    if (notification.method === "userInput/settled") {
      for (const [id, pending] of ctx.pendingUserInputs)
        if (pending.userInputId === notification.params.userInputId)
          yield* resolveInput(
            ctx,
            id,
            Object.fromEntries(
              notification.params.answers.map((a) => [
                a.questionId,
                a.selectedLabels ?? a.selectedLabel ?? a.freeText,
              ]),
            ),
          );
      return;
    }
    ctx.session = { ...ctx.session, updatedAt: yield* now };
    const stamped = yield* stamp(ctx.session.threadId);
    const mapped = mspNotificationToRuntimeEvents(
      {
        threadId: ctx.session.threadId,
        instanceId,
        createdAt: stamped.createdAt,
        eventId: stamped.eventId,
        ...(ctx.session.model ? { model: ctx.session.model } : {}),
        ...(ctx.activeTurnId ? { activeTurnId: ctx.activeTurnId } : {}),
        items: ctx.items,
      },
      notification,
    );
    if (notification.method === "session/contextUsage") ctx.contextUsage = notification.params;
    for (const event of mapped) {
      if (event.type === "turn.started") {
        ctx.activeTurnId = event.turnId;
        ctx.session = { ...ctx.session, status: "running", activeTurnId: event.turnId };
      }
      if (event.type === "turn.completed" && event.turnId === ctx.activeTurnId) {
        ctx.activeTurnId = undefined;
        const { activeTurnId: _, ...rest } = ctx.session;
        ctx.session = { ...rest, status: "ready" };
      }
      if (
        event.type === "thread.token-usage.updated" &&
        notification.method === "session/tokenUsage" &&
        ctx.contextUsage
      ) {
        yield* offer({
          ...event,
          payload: {
            usage: {
              ...event.payload.usage,
              usedTokens: ctx.contextUsage.usedTokens,
              ...(ctx.contextUsage.windowTokens
                ? { maxTokens: ctx.contextUsage.windowTokens }
                : {}),
            },
          },
        });
      } else yield* offer(event);
      if (event.type === "session.exited") {
        ctx.stopped = true;
        ctx.session = { ...ctx.session, status: "error" };
        for (const id of ctx.pendingApprovals.keys()) yield* resolveApproval(ctx, id, "cancel");
        for (const id of ctx.pendingUserInputs.keys()) yield* resolveInput(ctx, id, {});
        yield* ctx.runtime.stop;
      }
    }
  });
  const stopContext = (ctx: MuseContext) =>
    Effect.gen(function* () {
      ctx.stopped = true;
      for (const id of ctx.pendingApprovals.keys()) yield* resolveApproval(ctx, id, "cancel");
      for (const id of ctx.pendingUserInputs.keys()) yield* resolveInput(ctx, id, {});
      yield* Scope.close(ctx.scope, Exit.void);
    });
  const mcpConfigFor = (threadId: ThreadId): Msp.SessionConfig | undefined => {
    const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
    return mcpSession
      ? {
          mcpServers: {
            "t3-code": {
              transport: "streamableHttp",
              url: mcpSession.endpoint,
              headers: { Authorization: mcpSession.authorizationHeader },
              mode: "optional",
            },
          },
        }
      : undefined;
  };
  const spawnHost = (args: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly runtimeMode: MuseContext["session"]["runtimeMode"];
    readonly planMode: boolean;
    readonly queue: Queue.Queue<Incoming>;
    /**
     * Host generation at spawn time. A dying host emits a last gasp
     * (`session/closed` with reason `hostShutdown`); tagging frames lets the
     * pump drop them so a plan-mode respawn never kills its own stream.
     */
    readonly generation: number;
  }) =>
    Effect.gen(function* () {
      const mcpSession = McpProviderSession.readMcpProviderSession(args.threadId);
      return yield* makeMuseMspRuntime({
        settings,
        environment: McpProviderSession.withAgentDeviceEnvironment(
          options?.environment ?? process.env,
          mcpSession,
        ),
        spawner,
        cwd: args.cwd,
        runtimeMode: args.runtimeMode,
        ...(args.planMode ? { planMode: true as const } : {}),
        clientInfo: { name: "t3_code", version: "0.0.1" },
        onEvent: (method, params) =>
          Queue.offer(args.queue, {
            method,
            params,
            request: false,
            generation: args.generation,
          }).pipe(Effect.asVoid),
        onServerRequest: (method, params) =>
          Queue.offer(args.queue, {
            method,
            params,
            request: true,
            generation: args.generation,
          }).pipe(Effect.as({})),
        onWarning: (message) => warning(args.threadId, message),
        onError: (error) =>
          Effect.gen(function* () {
            if (error.data?.kind === "notInitialized")
              yield* offer({
                ...(yield* stamp(args.threadId)),
                type: "runtime.error",
                payload: { message: error.message, class: "provider_error", detail: error.data },
              });
          }),
        ...(options?.nativeEventLogger
          ? {
              logger: (event: unknown) => options.nativeEventLogger!.write(event, args.threadId),
            }
          : {}),
      });
    });
  // Watches one host process. Stale hosts (replaced by a plan-mode respawn)
  // resolve their `ended` too, but only the current generation may stop the
  // context.
  const watchHost = (ctx: MuseContext, runtime: MuseMspRuntime, generation: number) =>
    runtime.ended.pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() =>
          ctx.runtime === runtime && ctx.hostGeneration === generation
            ? Queue.offer(ctx.queue, { exited: true })
            : Effect.void,
        ),
      ),
      Effect.forkIn(ctx.scope),
    );
  // Sandbox posture is fixed per host process, so a mode flip stops the host
  // and resumes the same Muse session under a new one with the right flags.
  // The new host registers on the session scope and needs the host-spawn
  // services, which sendTurn does not otherwise provide.
  const ensurePosture = (ctx: MuseContext, desired: ProviderInteractionMode) =>
    Effect.gen(function* () {
      if (desired === ctx.interactionMode) return;
      const threadId = ctx.session.threadId;
      const cwd = ctx.session.cwd;
      if (!cwd) return yield* mapError("sendTurn")("Muse session lost its workspace directory.");
      // Retire the old host before it can report its own exit: its watcher
      // still fires, but the generation check drops the stale signal.
      ctx.hostGeneration += 1;
      const generation = ctx.hostGeneration;
      yield* ctx.runtime.stop.pipe(Effect.ignore);
      const runtime = yield* spawnHost({
        threadId,
        cwd,
        runtimeMode: ctx.session.runtimeMode,
        planMode: desired === "plan",
        queue: ctx.queue,
        generation,
      }).pipe(Effect.mapError(mapError("sendTurn")));
      const mcpConfig = mcpConfigFor(threadId);
      const resumed = yield* runtime
        .resumeSession({
          sessionId: ctx.sessionId,
          cursor: ctx.viewCursor,
          ...(mcpConfig ? { config: mcpConfig } : {}),
        })
        .pipe(Effect.mapError(mapError("session/resume")));
      ctx.runtime = runtime;
      updateCursor(ctx, resumed.viewCursor);
      ctx.interactionMode = desired;
      yield* watchHost(ctx, runtime, generation);
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Scope.Scope, ctx.scope),
    );
  const startSession: MuseAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (!input.cwd?.trim() || (input.provider !== undefined && input.provider !== PROVIDER))
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Muse requires a workspace directory and the muse provider.",
        });
      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* stopContext(existing);
        sessions.delete(input.threadId);
      }
      const scope = yield* Scope.make();
      const queue = yield* Queue.unbounded<Incoming>();
      const result = yield* Effect.gen(function* () {
        const mcpConfig = mcpConfigFor(input.threadId);
        const runtime = yield* spawnHost({
          threadId: input.threadId,
          cwd: input.cwd!,
          runtimeMode: input.runtimeMode,
          planMode: false,
          queue,
          // First host of the session; must match hostGeneration below.
          generation: 0,
        });
        const resume =
          input.resumeCursor === undefined
            ? undefined
            : yield* decodeResumeCursor(input.resumeCursor);
        const model = input.modelSelection?.model ?? settings.model;
        const started = yield* resume
          ? runtime.resumeSession({
              sessionId: resume.sessionId,
              cursor: resume.viewCursor,
              ...(mcpConfig ? { config: mcpConfig } : {}),
            })
          : runtime.startSession({
              ...(model ? { modelId: model } : {}),
              ...(mcpConfig ? { config: mcpConfig } : {}),
            });
        const timestamp = yield* now;
        const ctx: MuseContext = {
          runtime,
          scope,
          queue,
          sessionId: started.session.sessionId,
          viewCursor: started.viewCursor,
          activeTurnId: undefined,
          interactionMode: "default",
          hostGeneration: 0,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          items: new Map(),
          stopped: false,
          reserved: false,
          contextUsage: undefined,
          session: {
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            cwd: input.cwd!,
            runtimeMode: input.runtimeMode,
            status: "ready",
            ...(started.session.modelId ? { model: started.session.modelId } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        };
        updateCursor(ctx, started.viewCursor);
        sessions.set(input.threadId, ctx);
        yield* offer({
          ...(yield* stamp(input.threadId)),
          type: "session.started",
          payload: { resume: ctx.session.resumeCursor },
        });
        yield* offer({
          ...(yield* stamp(input.threadId)),
          type: "thread.started",
          payload: { providerThreadId: ctx.sessionId },
        });
        yield* offer({
          ...(yield* stamp(input.threadId)),
          type: "session.state.changed",
          payload: { state: "ready", reason: resume ? "session/resume" : "session/start" },
        });
        yield* Stream.fromQueue(queue).pipe(
          // Drop frames from retired hosts before anything else: a dying
          // host's last gasp (`session/closed`) must neither end this pump
          // nor mark the context stopped.
          Stream.filter(
            (incoming) => "exited" in incoming || incoming.generation === ctx.hostGeneration,
          ),
          Stream.takeUntil(
            (incoming) => "exited" in incoming || incoming.method === "session/closed",
          ),
          Stream.runForEach((incoming) =>
            processIncoming(ctx, incoming).pipe(
              Effect.catch((error) => warning(input.threadId, String(error))),
            ),
          ),
          Effect.forkIn(scope),
        );
        yield* watchHost(ctx, runtime, ctx.hostGeneration);
        return ctx.session;
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.timeout("30 seconds"),
        Effect.onError(() => Scope.close(scope, Exit.void)),
        Effect.mapError(mapError("startSession")),
      );
      return result;
    });
  const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      if (ctx.reserved || ctx.activeTurnId)
        return yield* mapError("sendTurn")("Muse already has a turn in progress.");
      ctx.reserved = true;
      return yield* Effect.gen(function* () {
        // Plan mode is a host posture, not a prompt instruction: flip the
        // host before the turn starts. Absent mode leaves posture unchanged.
        if (input.interactionMode !== undefined) yield* ensurePosture(ctx, input.interactionMode);
        const images = yield* Effect.forEach(
          (input.attachments ?? []).filter((a) => a.type === "image"),
          (attachment) =>
            Effect.gen(function* () {
              const path = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (!path) return yield* mapError("sendTurn")("Invalid Muse attachment path.");
              const bytes = yield* fs.readFile(path);
              return {
                type: "image" as const,
                base64Data: Buffer.from(bytes).toString("base64"),
                mediaType: attachment.mimeType,
              };
            }),
        );
        const text = input.input?.trim();
        if (!text && images.length === 0)
          return yield* mapError("sendTurn")("Muse requires text or image input.");
        const model = input.modelSelection?.model;
        if (model && model !== "default" && model !== ctx.session.model) {
          yield* ctx.runtime.setModel(ctx.sessionId, model);
          ctx.session = { ...ctx.session, model };
        }
        const effort =
          getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
          settings.reasoningEffort;
        const reasoningEffort = MUSE_REASONING_EFFORTS.find((value) => value === effort);
        ctx.items.clear();
        const turnId = TurnId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
        ctx.activeTurnId = turnId;
        const ack = yield* ctx.runtime
          .startTurn({
            sessionId: ctx.sessionId,
            commandId: turnId,
            input: [...(text ? [{ type: "text" as const, text }] : []), ...images],
            ...(reasoningEffort ? { reasoningEffort } : {}),
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                ctx.activeTurnId = undefined;
              }),
            ),
          );
        if (ack.disposition === "queued")
          yield* warning(input.threadId, "Muse queued the turn behind existing work.");
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.reserved = false;
          }),
        ),
        Effect.mapError(mapError("sendTurn")),
      );
    });
  const stopAll = () =>
    Effect.forEach(sessions.values(), stopContext, { discard: true }).pipe(
      Effect.andThen(Effect.sync(() => sessions.clear())),
    );
  yield* Effect.addFinalizer(stopAll);
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.runtime
          .interrupt(ctx.sessionId, turnId ?? ctx.activeTurnId)
          .pipe(Effect.mapError(mapError("turn/interrupt")));
      }),
    compaction: {
      type: "native",
      start: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const ack = yield* ctx.runtime
            .compact(ctx.sessionId)
            .pipe(Effect.mapError(mapError("session/compact")));
          if (ack.status === "noop") yield* warning(threadId, "Nothing to compact");
        }),
    },
    respondToRequest: (threadId, id, decision) =>
      requireSession(threadId).pipe(Effect.flatMap((ctx) => decide(ctx, id, decision))),
    respondToUserInput: (threadId, id, answers) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(id);
        if (!pending)
          return yield* mapError("userInput/answer")("Muse input request is no longer pending.");
        const mapped = pending.questions.map((q) => {
          const raw = answers[q.id];
          const selected =
            typeof raw === "string"
              ? [raw]
              : Array.isArray(raw) && raw.every((v): v is string => typeof v === "string")
                ? raw
                : [];
          if (
            !selected.length ||
            selected.some((label) => !q.options.some((o) => o.label === label)) ||
            (q.selection.mode === "single" && selected.length !== 1) ||
            selected.length < (q.selection.minSelections ?? 0) ||
            selected.length > (q.selection.maxSelections ?? Infinity)
          )
            return undefined;
          return q.selection.mode === "multiple"
            ? { questionId: q.id, selectedLabels: selected }
            : { questionId: q.id, selectedLabel: selected[0]! };
        });
        if (
          mapped.some((answer) => !answer) ||
          Object.keys(answers).some((key) => !pending.questions.some((q) => q.id === key))
        )
          yield* ctx.runtime
            .cancelUserInput(
              ctx.sessionId,
              pending.userInputId,
              "The answers did not match the available choices.",
            )
            .pipe(Effect.mapError(mapError("userInput/cancel")));
        else
          yield* ctx.runtime
            .answerUserInput(
              ctx.sessionId,
              pending.userInputId,
              mapped.filter((a) => a !== undefined),
            )
            .pipe(Effect.mapError(mapError("userInput/answer")));
        yield* resolveInput(ctx, id, answers);
      }),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (ctx) yield* stopContext(ctx);
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) => requireSession(threadId).pipe(Effect.as({ threadId, turns: [] })),
    // MSP v1 has no rewind: `session/fork` rejects cuts at non-head turns
    // with `forkBoundaryInvalid` and wedges the host without answering when
    // the cut names a text-only turn, so provider-side rollback stays
    // unsupported until the protocol grows a real rewind.
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(mapError("rollbackThread")("Muse does not support conversation rollback.")),
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  } satisfies MuseAdapterShape;
});
