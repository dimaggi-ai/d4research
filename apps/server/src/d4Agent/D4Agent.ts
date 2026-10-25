import * as SessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Pipelines from "./D4AgentPipelines.ts";
import * as Lifecycle from "./D4AgentThreadLifecycle.ts";
import {
  resolveAgentReference,
  referenceContext,
  validateReplyReferences,
  type AgentReference,
} from "./references.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { createScopedBrain } from "./brain/scopedBrain.ts";
import { createCtoClient } from "./cto/CtoClient.ts";
import { contextScopeHash, projectInScope, projectContentInScope } from "./brainScope.ts";
import { sha256Hex } from "@d4research/shared/hash";
import { randomUuidV4 as randomUUID } from "@d4research/provider-core/server/randomUuid";
import {
  CommandId,
  D4AgentError,
  D4BrainContext,
  type D4AgentSwitchContextInput,
  type D4AgentResolveMemoryProposalInput,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderSessionId,
  ThreadId,
  type D4AgentIdentity,
  type OrchestrationV2ThreadProjection,
  type D4AgentGetActionInput,
  type D4AgentActionSummary,
  type D4AgentSystemHealthState,
  type D4AgentClaimSystemAttentionInput,
  D4AgentAction,
  type D4AgentActionRecord,
  type D4AgentResolveActionInput,
  type D4AgentSendInput,
  type D4AgentSettings,
  type D4AgentState,
  type D4AgentSystemCheck,
  type D4AgentEnsureThreadResult,
} from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as D4AgentAccess from "./D4AgentAccess.ts";
import * as D4AgentStore from "./D4AgentStore.ts";
import * as SystemProbe from "./SystemProbe.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentMonitor from "../orchestration-v2/AgentMonitorReactor.ts";
import { contentFreeDigest, heartbeatDue, modelAvailability, usageAttributes } from "./policy.ts";

export class D4Agent extends Context.Service<
  D4Agent,
  {
    readonly closeSession: (
      input: D4AgentSwitchContextInput,
    ) => Effect.Effect<D4AgentState, D4AgentError>;
    readonly undoArchive: (
      input: D4AgentGetActionInput,
    ) => Effect.Effect<D4AgentState, D4AgentError>;
    readonly listPipelines: () => Effect.Effect<
      {
        readonly pipelines: ReadonlyArray<Pipelines.ScopedPipeline>;
        readonly modelSelection: ModelSelection;
        readonly projects: ReadonlyArray<{ readonly projectId: ProjectId; readonly title: string }>;
      },
      D4AgentError
    >;
    readonly resolveReference: (text: string) => Effect.Effect<unknown, D4AgentError>;
    readonly newSession: () => Effect.Effect<typeof D4AgentEnsureThreadResult.Type, D4AgentError>;
    readonly resolveMemoryProposal: (
      input: D4AgentResolveMemoryProposalInput,
    ) => Effect.Effect<D4AgentState, D4AgentError>;
    readonly switchContext: (
      input: D4AgentSwitchContextInput,
    ) => Effect.Effect<typeof D4AgentEnsureThreadResult.Type, D4AgentError>;
    readonly memorySearch: (input: {
      context: D4BrainContext;
      query: string;
      limit?: number;
    }) => Effect.Effect<unknown, D4AgentError>;
    readonly memoryRead: (input: {
      context: D4BrainContext;
      path: string;
    }) => Effect.Effect<unknown, D4AgentError>;
    readonly ctoRead: (input: {
      context: D4BrainContext;
      operation: "status" | "brief";
    }) => Effect.Effect<unknown, D4AgentError>;
    readonly claimSystemAttention: (
      input: D4AgentClaimSystemAttentionInput,
    ) => Effect.Effect<{ readonly claimed: boolean }, D4AgentError>;
    readonly getIdentity: () => Effect.Effect<D4AgentIdentity>;
    readonly getAction: (input: D4AgentGetActionInput) => Effect.Effect<D4AgentActionRecord | null>;
    readonly getSystemHealth: () => Effect.Effect<D4AgentSystemHealthState, D4AgentError>;
    readonly getState: () => Effect.Effect<D4AgentState, D4AgentError>;
    readonly ensureThread: () => Effect.Effect<typeof D4AgentEnsureThreadResult.Type, D4AgentError>;
    readonly sendMessage: (
      input: D4AgentSendInput,
    ) => Effect.Effect<typeof D4AgentEnsureThreadResult.Type, D4AgentError>;
    readonly resolveAction: (
      input: D4AgentResolveActionInput,
    ) => Effect.Effect<D4AgentState, D4AgentError>;
    readonly requestAction: (
      action: D4AgentAction,
    ) => Effect.Effect<D4AgentActionRecord, D4AgentError>;
    readonly list: () => Effect.Effect<
      ReturnType<typeof contentFreeDigest> & {
        readonly monitorEnabled: boolean;
        readonly threads: ReadonlyArray<{
          readonly threadId: ThreadId;
          readonly title: string;
          readonly status: string;
          readonly report: ReturnType<typeof contentFreeDigest>["reports"][number] | null;
        }>;
        readonly omittedThreads: number;
      },
      D4AgentError
    >;
    readonly readTail: (
      threadId: ThreadId,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly role: string; readonly text: string }>,
      D4AgentError
    >;
    readonly systemHealth: () => Effect.Effect<ReadonlyArray<D4AgentSystemCheck>, D4AgentError>;
    readonly tick: Effect.Effect<void, D4AgentError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("d4research/d4Agent/D4Agent") {}

const validateAction = Schema.decodeUnknownEffect(D4AgentAction);
const encodeDigest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const storageError = (cause: unknown) => new D4AgentError({ reason: "storage", cause });
const threadError = (cause: unknown) => new D4AgentError({ reason: "thread", cause });
const command = (id: string) => CommandId.make(`d4-agent:${id}`);
const actionTarget = (action: D4AgentAction) =>
  "projectId" in action
    ? action.projectId
    : "context" in action
      ? `${action.type}:${action.context}`
      : action.threadId;
export const requiresActionApproval = (
  mode: D4AgentSettings["permissionMode"],
  action: D4AgentAction,
) =>
  mode === "ask" ||
  action.type === "send" ||
  action.type === "start" ||
  action.type === "research" ||
  action.type === "pipeline";

export function actionSummaries(
  actions: ReadonlyArray<D4AgentActionRecord>,
): ReadonlyArray<D4AgentActionSummary> {
  return [
    ...actions.filter((a) => a.status === "pending"),
    ...actions.filter((a) => a.status !== "pending").slice(-20),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, action, status, createdAt, resolvedAt }) => ({
      id,
      type: action.type,
      targetId: actionTarget(action),
      preview: ("text" in action
        ? action.text
        : action.type === "answer"
          ? JSON.stringify(action.answers)
          : ""
      ).slice(0, 256),
      status,
      createdAt,
      resolvedAt,
    }));
}
const cachedHealth = (
  state: D4AgentStore.StoredState,
  config: {
    readonly d4Agent: D4AgentSettings;
    readonly agentMonitor: {
      readonly enabled: boolean;
      readonly notificationsEnabled: boolean;
      readonly notifyClasses: ReadonlyArray<string>;
    };
  },
): ReadonlyArray<D4AgentSystemCheck> =>
  !config.d4Agent.systemProbeEnabled
    ? SystemProbe.disabledChecks()
    : state.systemEpisodes.map(({ check }) => ({
        ...check,
        notificationEligible:
          check.notificationEligible &&
          config.agentMonitor.enabled &&
          config.agentMonitor.notificationsEnabled &&
          config.agentMonitor.notifyClasses.includes("system"),
      }));

export const layer = Layer.effect(
  D4Agent,
  Effect.gen(function* () {
    const serviceScope = yield* Scope.Scope;
    let ctoAsk: { id: string; fiber: Fiber.Fiber<void, never> } | undefined;
    const store = yield* D4AgentStore.D4AgentStore;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectService.ProjectService;
    const monitor = yield* AgentMonitor.AgentMonitorReactor;
    const probe = yield* SystemProbe.SystemProbe;
    const sessionManager = yield* Effect.serviceOption(SessionManager.ProviderSessionManagerV2);
    const pipelines = yield* Pipelines.D4AgentPipelines.pipe(Effect.provide(Pipelines.layer));
    const lifecycle = yield* Lifecycle.D4AgentThreadLifecycle.pipe(Effect.provide(Lifecycle.layer));
    const path = yield* Effect.serviceOption(Path.Path);
    let brainDiagnostic: { operation: string; category: string } | undefined;
    const brain = createScopedBrain({
      stateDir: Option.isSome(path)
        ? path.value.resolve(store.workspace, "../..")
        : `${store.workspace}/../..`,
      diagnostic: (entry) => {
        brainDiagnostic = entry;
      },
    });
    const memoryFailure = () =>
      Effect.logWarning(
        "Scoped memory operation refused",
        brainDiagnostic ?? { category: "unavailable" },
      );
    const cto = createCtoClient();
    const lock = yield* Semaphore.make(1);
    const healthLock = yield* Semaphore.make(1);
    const usageLock = yield* Semaphore.make(1);
    const settings = settingsService.getSettings.pipe(
      Effect.map((value) => value.d4Agent),
      Effect.mapError(storageError),
    );
    const selected = Effect.gen(function* () {
      const config = yield* settings;
      const reason = modelAvailability(config, yield* providers.getProviders);
      if (reason !== null) return yield* new D4AgentError({ reason });
      return config.modelSelection!;
    });
    const bound = Effect.fn("D4Agent.bound")(function* (context?: D4BrainContext) {
      const state = yield* store.get;
      const config = yield* settings;
      const caller = yield* D4AgentAccess.ToolCaller;
      if (
        (context !== undefined && (state.threadId === null || !config.enabled)) ||
        (caller !== undefined && (caller !== state.threadId || !config.enabled)) ||
        (context !== undefined && context !== state.brainContext) ||
        (state.threadId !== null &&
          state.contextScopeHash !== contextScopeHash(state.brainContext, config))
      )
        return yield* new D4AgentError({ reason: "context" });
      return { state, config };
    });
    const scopedThreads = Effect.fn("D4Agent.scopedThreads")(function* () {
      const { state, config } = yield* bound();
      const shell = yield* threads.getShellSnapshot().pipe(Effect.mapError(threadError));
      return shell.threads.filter(
        (thread) =>
          thread.projectId !== state.projectId &&
          projectInScope(state.brainContext, config, thread.projectId),
      );
    });
    const finishRetirement = Effect.fn("D4Agent.finishRetirement")(function* () {
      const state = yield* store.get;
      if (state.retiringThreadId === null) return;
      const previous = yield* threads
        .getThreadShell(state.retiringThreadId)
        .pipe(Effect.mapError(threadError));
      if (previous !== null && previous.deletedAt === null) {
        yield* threads
          .dispatch({
            type: "thread.stop",
            commandId: command(`context-stop:${state.retiringThreadId}`),
            threadId: state.retiringThreadId,
          })
          .pipe(
            Effect.provideService(D4AgentAccess.DispatchOrigin, "authenticated-user"),
            Effect.mapError(threadError),
          );
        yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: command(`context-archive:${state.retiringThreadId}`),
            threadId: state.retiringThreadId,
          })
          .pipe(
            Effect.provideService(D4AgentAccess.DispatchOrigin, "authenticated-user"),
            Effect.mapError(threadError),
          );
      }
      if (state.retiringProviderSessionId) {
        if (Option.isNone(sessionManager)) return yield* new D4AgentError({ reason: "storage" });
        yield* sessionManager.value
          .detach({
            providerSessionId: ProviderSessionId.make(state.retiringProviderSessionId),
            threadId: state.retiringThreadId,
            revokeMcpCredential: true,
          })
          .pipe(Effect.mapError(threadError));
      }
      yield* store.update((value) => ({
        ...value,
        retiringThreadId: null,
        retiringProviderSessionId: null,
      }));
    });
    const appendDisplay = Effect.fn("D4Agent.appendDisplay")(function* (
      text: string,
      role: "user" | "system",
      id?: string,
    ) {
      const state = yield* store.get;
      const entry = {
        id: id ?? (yield* randomUUID),
        role,
        text,
        context: state.brainContext,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        links: [],
      };
      yield* store.update((value) => ({
        ...value,
        transcript: [...(value.transcript ?? []), entry].slice(-200),
      }));
    });
    const close = Effect.fn("D4Agent.close")(function* (context: D4BrainContext) {
      yield* finishRetirement();
      const state = yield* store.get;
      const session = state.sessions?.find((entry) => entry.context === context);
      if (!session) return;
      yield* store.update((value) => ({
        ...value,
        retiringThreadId: session.threadId,
        retiringProviderSessionId: session.providerSessionId,
        rotation: value.rotation?.threadId === session.threadId ? null : (value.rotation ?? null),
        sessions: (value.sessions ?? []).filter((entry) => entry.threadId !== session.threadId),
        bindings: value.bindings.filter((entry) => entry.threadId !== session.threadId),
        ...(value.threadId === session.threadId ? { threadId: null, identityReady: false } : {}),
        actions: value.actions.map((entry) =>
          entry.sessionId === session.threadId && entry.status === "pending"
            ? { ...entry, status: "denied" as const }
            : entry,
        ),
      }));
      yield* finishRetirement();
    });
    const rotate = Effect.fn("D4Agent.rotate")(function* (
      context: D4BrainContext,
      reason: "context" | "new-session" | "size" = "context",
      seedSummary?: string,
    ) {
      yield* finishRetirement();
      yield* adoptLegacySession;
      yield* captureDisplay();
      const config = yield* settings;
      const existing = (yield* store.get).sessions?.find((entry) => entry.context === context);
      const canResume =
        reason === "context" && existing?.scopeHash === contextScopeHash(context, config);
      if (existing && !canResume) yield* close(context);
      const threadId = canResume ? existing.threadId : ThreadId.make(yield* randomUUID);
      const changedAt = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((value) => ({
        ...value,
        threadId,
        identityReady: canResume,
        brainContext: context,
        contextScopeHash: contextScopeHash(context, config),
        contextChangedAt: changedAt,
        sessionChangeReason: canResume ? "resumed" : reason,
        heartbeatAt: 0,
        heartbeatKeys: [],
        usageCursor: "",
        lastUserText: "",
        sessions: [
          ...(value.sessions ?? []).filter((entry) => entry.context !== context),
          canResume
            ? { ...existing, lastActivityAt: changedAt }
            : {
                context,
                threadId,
                providerSessionId: null,
                lastActivityAt: changedAt,
                inputTokens: 0,
                contextWindow: null,
                scopeHash: contextScopeHash(context, config),
                ...(seedSummary === undefined ? {} : { seedSummary }),
              },
        ],
      }));
      yield* appendDisplay(
        canResume
          ? `Resumed ${context} session.`
          : reason === "new-session"
            ? "New session."
            : reason === "size"
              ? `Session size limit reached. New ${context} session.`
              : `Context changed to ${context}. New session.`,
        "system",
      );
    });
    const ensure = Effect.fn("D4Agent.ensureThread")(function* () {
      const selection = yield* selected;
      yield* finishRetirement();
      let state = yield* store.get;
      const config = yield* settings;
      if (
        (state.threadId === null && state.projectId !== null) ||
        (state.threadId !== null &&
          state.contextScopeHash !== contextScopeHash(state.brainContext, config))
      ) {
        yield* rotate(state.brainContext, "new-session");
        state = yield* store.get;
      }
      // Persist identity before commands so interrupted creation retries the same receipts.
      if (state.threadId === null || state.projectId === null) {
        const threadId = state.threadId ?? ThreadId.make(yield* randomUUID),
          projectId = state.projectId ?? ProjectId.make(yield* randomUUID);
        state = yield* store.update((value) => ({
          ...value,
          threadId,
          projectId,
          contextScopeHash: contextScopeHash(value.brainContext, config),
        }));
      }
      const threadId = state.threadId!,
        projectId = state.projectId!;
      yield* projects
        .create({
          commandId: command(`project:${projectId}`),
          projectId,
          title: "d4 Agent",
          workspaceRoot: store.workspace,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: selection,
        })
        .pipe(Effect.mapError(threadError));
      const existing = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(threadError));
      if (existing === null)
        yield* threads
          .dispatch({
            type: "thread.create",
            commandId: command(`thread:${threadId}`),
            threadId,
            projectId,
            title: "d4 Agent",
            modelSelection: selection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadError));
      else if (existing.deletedAt !== null) return yield* new D4AgentError({ reason: "thread" });
      if (existing?.archivedAt !== null && existing !== null)
        yield* threads
          .dispatch({ type: "thread.unarchive", commandId: command(yield* randomUUID), threadId })
          .pipe(Effect.mapError(threadError));
      yield* threads
        .dispatch({ type: "thread.pin", commandId: command(`pin:${threadId}`), threadId })
        .pipe(Effect.mapError(threadError));
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((value) => ({
        ...value,
        identityReady: true,
        chatThreadIds: [...new Set([...(value.chatThreadIds ?? []), threadId])].slice(-256),
        sessions: value.sessions?.some((entry) => entry.threadId === threadId)
          ? value.sessions
          : [
              ...(value.sessions ?? []).filter((entry) => entry.context !== value.brainContext),
              {
                context: value.brainContext,
                threadId,
                providerSessionId: null,
                lastActivityAt: at,
                inputTokens: 0,
                contextWindow: null,
                scopeHash: contextScopeHash(value.brainContext, config),
              },
            ],
      }));
      return { threadId, projectId };
    });
    const referenceCatalog = Effect.gen(function* () {
      const state = yield* store.get;
      const config = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
      const shell = yield* threads.getShellSnapshot().pipe(Effect.mapError(threadError));
      const visible = shell.threads.filter(
        (entry) => entry.deletedAt === null && entry.projectId !== state.projectId,
      );
      const catalog: AgentReference[] = visible.map((entry) => ({
        kind: "thread",
        id: entry.id,
        title: entry.title,
        projectId: entry.projectId,
        threadId: entry.id,
      }));
      const allProjects = yield* projects.listShells().pipe(Effect.mapError(threadError));
      for (const project of allProjects) {
        if (project.id === state.projectId) continue;
        catalog.push({
          kind: "project",
          id: project.id,
          title: project.title,
          projectId: project.id,
          threadId: visible.find((thread) => thread.projectId === project.id)?.id ?? null,
        });
      }
      for (const kind of ["dev", "research"] as const)
        for (const scenario of config[kind].scenarios) {
          const id = `${kind}:${scenario.name}`;
          catalog.push({
            kind: "pipeline",
            id,
            title: scenario.name,
            projectId: config.d4Agent.pipelineProjects[id] ?? null,
            threadId: null,
          });
        }
      return catalog;
    });
    const sessionSnapshots = new Map<
      string,
      { cursor: string; projection: OrchestrationV2ThreadProjection }
    >();
    const sessionSnapshot = Effect.fn("D4Agent.sessionSnapshot")(function* (
      threadId: ThreadId,
      cursor: string,
    ) {
      const cached = sessionSnapshots.get(threadId);
      if (cached?.cursor === cursor) return cached.projection;
      const { projection } = yield* projections
        .getThreadSnapshotWindow(threadId, { rowLimit: 100, userTurnLimit: 30 })
        .pipe(Effect.mapError(threadError));
      sessionSnapshots.set(threadId, { cursor, projection });
      for (const id of sessionSnapshots.keys())
        if (!(yield* store.get).sessions?.some((entry) => entry.threadId === id))
          sessionSnapshots.delete(id);
      return projection;
    });
    const displayCursors = new Map<string, string>();
    const captureDisplay = Effect.fn("D4Agent.captureDisplay")(function* () {
      const state = yield* store.get;
      const config = yield* settings;
      let references: AgentReference[] | undefined;
      for (const session of state.sessions ?? []) {
        const shell = yield* threads
          .getThreadShell(session.threadId)
          .pipe(Effect.mapError(threadError));
        if (shell === null) continue;
        const cursor = `${DateTime.formatIso(shell.updatedAt)}:${shell.latestRunId ?? ""}:${shell.activeRunId ?? ""}`;
        if (displayCursors.get(session.threadId) === cursor) continue;
        const projection = yield* sessionSnapshot(session.threadId, cursor);
        const summaryRuns = new Set(
          projection.runs
            .filter((run) => String(run.userMessageId).startsWith("d4-summary:"))
            .map((run) => run.id),
        );
        const messages = projection.messages.filter(
          (message) =>
            (message.role === "assistant" || message.role === "system") &&
            message.text.trim() &&
            (message.runId === null || !summaryRuns.has(message.runId)),
        );
        if (messages.length > 0) {
          references ??= yield* referenceCatalog;
          const entries = messages.map((message) => ({
            id: message.id,
            role: message.role === "assistant" ? ("assistant" as const) : ("system" as const),
            context: session.context,
            createdAt: DateTime.formatIso(message.createdAt),
            ...validateReplyReferences(
              message.text.slice(0, 16000),
              references!,
              session.context,
              config,
            ),
          }));
          yield* store.update((value) => {
            const all = [...(value.transcript ?? [])];
            for (const entry of entries) {
              const index = all.findIndex((old) => old.id === entry.id);
              if (index < 0) all.push(entry);
              else all[index] = entry;
            }
            return { ...value, transcript: all.slice(-200) };
          });
        }
        displayCursors.set(session.threadId, cursor);
      }
    });
    const send = Effect.fn("D4Agent.sendMessage")(function* (
      input: D4AgentSendInput,
      heartbeat = false,
      id?: string,
      resumedAfterRotation = false,
    ) {
      id ??= yield* randomUUID;
      if (!heartbeat) {
        if ((yield* store.get).rotation) return yield* new D4AgentError({ reason: "busy" });
        const resolved = resolveAgentReference(input.text, yield* referenceCatalog);
        if (resolved.kind === "ambiguous") {
          const identity = yield* ensure();
          yield* appendDisplay(input.text, "user");
          yield* appendDisplay(
            `Which thread, project, or pipeline do you mean? ${resolved.candidates
              .slice(0, 6)
              .map((target) => `${target.title} (${target.id})`)
              .join("; ")}`,
            "system",
          );
          return identity;
        }
        if (resolved.kind === "resolved") {
          const context = referenceContext(resolved.target, yield* settings);
          if ((yield* store.get).brainContext !== context) yield* rotate(context);
        }
      }
      yield* maintainSessions();
      const identity = yield* ensure();
      const modelSelection = yield* selected;
      const at = DateTime.formatIso(yield* DateTime.now);
      if (!heartbeat && !resumedAfterRotation) {
        yield* appendDisplay(input.text, "user", `d4-agent:${id}`);
        yield* store.update((value) => ({ ...value, lastUserText: input.text }));
      }
      yield* store.update((value) => ({
        ...value,
        sessions: (value.sessions ?? []).map((entry) =>
          entry.threadId === identity.threadId ? { ...entry, lastActivityAt: at } : entry,
        ),
      }));
      const current = yield* store.get;
      const session = current.sessions?.find((entry) => entry.threadId === identity.threadId);
      const budget = (yield* settings).sessionBudgetPercent;
      if (
        !resumedAfterRotation &&
        session?.contextWindow != null &&
        session.inputTokens >= (session.contextWindow * budget) / 100
      ) {
        yield* beginRotation(input.text, heartbeat);
        return identity;
      }
      yield* threads
        .sendToThread({
          ...identity,
          commandId: command(`message:${id}`),
          messageId: MessageId.make(`d4-agent:${id}`),
          text: input.text,
          attachments: [],
          modelSelection,
          mode: "queue",
          createdBy: heartbeat ? "system" : "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(threadError));
      return identity;
    });
    const digest = Effect.fn("D4Agent.digest")(function* () {
      const state = yield* store.get;
      const visible = new Set((yield* scopedThreads()).map((thread) => thread.id));
      return contentFreeDigest(
        (yield* monitor.snapshot.pipe(Effect.mapError(threadError))).filter((update) =>
          visible.has(update.threadId),
        ),
        yield* Clock.currentTimeMillis,
        state.threadId,
      );
    });
    const list = Effect.fn("D4Agent.list")(function* () {
      const reports = yield* digest();
      const config = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
      const state = yield* store.get;
      const topLevel = (yield* scopedThreads()).filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.lineage.parentThreadId === null &&
          thread.id !== state.threadId,
      );
      const byThread = new Map(reports.reports.map((report) => [report.threadId, report]));
      return {
        ...reports,
        monitorEnabled: config.agentMonitor.enabled,
        threads: topLevel.slice(0, 200).map((thread) => ({
          threadId: thread.id,
          title: thread.title.slice(0, 256),
          status: thread.status,
          report: byThread.get(thread.id) ?? null,
        })),
        omittedThreads: Math.max(0, topLevel.length - 200),
      };
    });
    const systemHealth = () =>
      healthLock.withPermits(1)(
        Effect.gen(function* () {
          const allSettings = yield* settingsService.getSettings.pipe(
            Effect.mapError(storageError),
          );
          const config = allSettings.d4Agent;
          if (!config.systemProbeEnabled) {
            const state = yield* store.get;
            if (state.systemEpisodes.length > 0 || state.systemClaims.length > 0)
              yield* store.update((value) => ({ ...value, systemEpisodes: [], systemClaims: [] }));
            return SystemProbe.disabledChecks();
          }
          const checks = yield* probe.check(config.diskWarningPercent);
          const now = yield* Clock.currentTimeMillis;
          const eligible =
            allSettings.agentMonitor.enabled &&
            allSettings.agentMonitor.notificationsEnabled &&
            allSettings.agentMonitor.notifyClasses.includes("system");
          const previous = yield* store.get;
          const episodes = checks.map((check) => {
            const old = previous.systemEpisodes.find((entry) => entry.check.id === check.id);
            const fingerprint = check.reportKey;
            const same = old?.check.reportKey.startsWith(`${fingerprint}:episode:`) === true;
            const since = same ? old!.since : now;
            const baseline = same ? old!.baseline : old === undefined;
            return {
              since,
              baseline,
              check: {
                ...check,
                reportKey: same ? old!.check.reportKey : `${fingerprint}:episode:${now}`,
                notificationEligible:
                  eligible && check.status === "attention" && !baseline && now - since < 300_000,
              },
            };
          });
          const staleClaims = previous.systemClaims.some(
            (claim) =>
              now - claim.at >= 7 * 86400_000 ||
              !episodes.some((entry) => entry.check.reportKey === claim.reportKey),
          );
          if (
            staleClaims ||
            episodes.some((entry, index) => {
              const old = previous.systemEpisodes[index];
              return (
                old === undefined ||
                old.check.reportKey !== entry.check.reportKey ||
                old.check.value !== entry.check.value ||
                old.check.notificationEligible !== entry.check.notificationEligible
              );
            })
          )
            yield* store.update((value) => ({
              ...value,
              systemEpisodes: episodes,
              systemClaims: value.systemClaims
                .filter(
                  (claim) =>
                    now - claim.at < 7 * 86400_000 &&
                    episodes.some((entry) => entry.check.reportKey === claim.reportKey),
                )
                .slice(-4096),
            }));
          return episodes.map((entry) => entry.check);
        }),
      );
    const claimSystemAttention = (input: D4AgentClaimSystemAttentionInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const checks = yield* systemHealth();
          if (
            !checks.some(
              (entry) => entry.reportKey === input.reportKey && entry.notificationEligible,
            )
          )
            return { claimed: false };
          const state = yield* store.get;
          if (
            state.systemClaims.some(
              (entry) => entry.clientId === input.clientId && entry.reportKey === input.reportKey,
            )
          )
            return { claimed: false };
          const at = yield* Clock.currentTimeMillis;
          yield* store.update((value) => ({
            ...value,
            systemClaims: [...value.systemClaims, { ...input, at }].slice(-4096),
          }));
          return { claimed: true };
        }),
      );
    const usageCursors = new Map<string, string>();
    const captureUsage = usageLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* store.get;
        for (const session of state.sessions ?? []) {
          const shell = yield* threads
            .getThreadShell(session.threadId)
            .pipe(Effect.mapError(threadError));
          if (shell === null) continue;
          const cursor = `${DateTime.formatIso(shell.updatedAt)}:${shell.latestRunId ?? ""}:${shell.activeRunId ?? ""}`;
          if (usageCursors.get(session.threadId) === cursor) continue;
          const records = yield* sessionSnapshot(session.threadId, cursor);
          const catalog = yield* providers.getProviders;
          const additions = records.providerTurns.flatMap((turn) => {
            if (turn.completedAt === null || state.usage.some((entry) => entry.runId === turn.id))
              return [];
            const attempt = records.attempts.find(
              (candidate) => candidate.id === turn.runAttemptId,
            );
            const run = records.runs.find((candidate) => candidate.id === attempt?.runId);
            if (!run) return [];
            const counters = turn.turnTokenUsage;
            const driver =
              records.providerThreads.find((entry) => entry.id === turn.providerThreadId)?.driver ??
              catalog.find((entry) => entry.instanceId === run.modelSelection.instanceId)?.driver ??
              run.modelSelection.instanceId;
            return [
              {
                runId: turn.id,
                recordedAt: DateTime.formatIso(turn.completedAt),
                attributes: usageAttributes({
                  provider: driver,
                  model: run.modelSelection.model,
                  conversationId: session.threadId,
                  durationMs:
                    turn.startedAt === null
                      ? 0
                      : DateTime.toEpochMillis(turn.completedAt) -
                        DateTime.toEpochMillis(turn.startedAt),
                  ...(counters?.inputTokens === undefined
                    ? {}
                    : { inputTokens: counters.inputTokens }),
                  ...(counters?.outputTokens === undefined
                    ? {}
                    : { outputTokens: counters.outputTokens }),
                  ...(counters?.cachedInputTokens === undefined
                    ? {}
                    : { cachedInputTokens: counters.cachedInputTokens }),
                  ...(driver === "codex" || counters?.cacheCreationTokens === undefined
                    ? {}
                    : { cacheCreationTokens: counters.cacheCreationTokens }),
                }),
              },
            ];
          });
          const currentUsage = records.providerThreads.find(
            (entry) => entry.id === shell.activeProviderThreadId,
          )?.contextUsage;
          const recordedInput = additions.map(
            (entry) => entry.attributes["gen_ai.usage.input_tokens"] ?? 0,
          );
          const maxTokens = currentUsage?.maxTokens ?? session.contextWindow;
          if (additions.length > 0 || maxTokens !== session.contextWindow)
            yield* store.update((value) => ({
              ...value,
              usage: [...value.usage, ...additions].slice(-100),
              sessions: (value.sessions ?? []).map((entry) =>
                entry.threadId === session.threadId
                  ? {
                      ...entry,
                      inputTokens: Math.max(entry.inputTokens, ...recordedInput),
                      contextWindow: maxTokens,
                      lastActivityAt: additions.at(-1)?.recordedAt ?? entry.lastActivityAt,
                    }
                  : entry,
              ),
            }));
          usageCursors.set(session.threadId, cursor);
        }
      }),
    );
    const adoptLegacySession = Effect.gen(function* () {
      const state = yield* store.get;
      if (state.threadId === null || (state.sessions?.length ?? 0) > 0) return;
      const config = yield* settings;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((value) => ({
        ...value,
        sessions: [
          {
            context: state.brainContext,
            threadId: state.threadId!,
            providerSessionId:
              state.bindings.findLast((binding) => binding.threadId === state.threadId)
                ?.sessionId ?? null,
            lastActivityAt: at,
            inputTokens: 0,
            contextWindow: null,
            scopeHash: state.contextScopeHash ?? contextScopeHash(state.brainContext, config),
          },
        ],
      }));
    });
    const maintainSessions = Effect.fn("D4Agent.maintainSessions")(function* () {
      yield* adoptLegacySession;
      yield* captureUsage;
      const config = yield* settings;
      const now = yield* Clock.currentTimeMillis;
      for (const session of (yield* store.get).sessions ?? []) {
        const shell = yield* threads
          .getThreadShell(session.threadId)
          .pipe(Effect.mapError(threadError));
        if (
          !config.enabled ||
          (config.sessionIdleMinutes !== null &&
            now - Date.parse(session.lastActivityAt) >= config.sessionIdleMinutes * 60_000 &&
            shell?.activeRunId == null &&
            shell?.pendingRuntimeRequest == null &&
            (shell?.pendingBackgroundTasks?.length ?? 0) === 0)
        ) {
          yield* captureDisplay();
          yield* close(session.context);
        }
      }
    });
    const beginRotation = Effect.fn("D4Agent.beginRotation")(function* (
      pendingText: string,
      heartbeat: boolean,
    ) {
      const state = yield* store.get;
      if (state.rotation || state.threadId === null || state.projectId === null) return;
      const summaryId = `d4-summary:${yield* randomUUID}`;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((value) => ({
        ...value,
        rotation: {
          threadId: state.threadId!,
          context: state.brainContext,
          messageId: summaryId,
          pendingText,
          requestedAt: at,
          heartbeat,
        },
      }));
      yield* threads
        .sendToThread({
          threadId: state.threadId,
          projectId: state.projectId,
          commandId: command(summaryId),
          messageId: MessageId.make(summaryId),
          text: "Summarize this session in at most 300 words for a fresh session in the same bound context. Keep decisions, open work and relevant identifiers. Use only this session. Do not call tools or act on any requests.",
          attachments: [],
          modelSelection: yield* selected,
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.provideService(D4AgentAccess.DispatchOrigin, "internal-server"),
          Effect.mapError(threadError),
        );
    });
    const deliverRotated = Effect.fn("D4Agent.deliverRotated")(function* (
      rotation: NonNullable<D4AgentStore.StoredState["rotation"]>,
    ) {
      if (rotation.pendingText)
        yield* send(
          { text: rotation.pendingText },
          rotation.heartbeat ?? false,
          undefined,
          true,
        ).pipe(Effect.provideService(D4AgentAccess.DispatchOrigin, "internal-server"));
      else yield* ensure();
    });
    const finishRotation = Effect.fn("D4Agent.finishRotation")(function* () {
      const state = yield* store.get;
      const rotation = state.rotation;
      if (!rotation) return;
      const config = yield* settings;
      const source = state.sessions?.find(
        (session) => session.threadId === rotation.threadId && session.context === rotation.context,
      );
      if (
        source?.scopeHash !== contextScopeHash(rotation.context, config) ||
        state.threadId !== rotation.threadId
      ) {
        yield* store.update((value) => ({ ...value, rotation: null }));
        yield* rotate(rotation.context, "size");
        yield* appendDisplay(
          "The context configuration changed. Started a new session without the previous summary.",
          "system",
        );
        yield* deliverRotated(rotation);
        return;
      }
      const projection = yield* projections
        .getThreadProjection(rotation.threadId)
        .pipe(Effect.mapError(threadError));
      const run = projection.runs.find((entry) => entry.userMessageId === rotation.messageId);
      const response = projection.messages.findLast(
        (message) => message.role === "assistant" && message.runId === run?.id,
      );
      if (run?.status !== "completed" || !response?.text.trim()) {
        if (
          run?.status === "failed" ||
          run?.status === "interrupted" ||
          (yield* Clock.currentTimeMillis) - Date.parse(rotation.requestedAt) > 120_000
        ) {
          yield* store.update((value) => ({ ...value, rotation: null }));
          yield* rotate(rotation.context, "size");
          yield* appendDisplay(
            "The previous session could not produce a summary. Started a new session.",
            "system",
          );
          yield* deliverRotated(rotation);
        }
        return;
      }
      yield* store.update((value) => ({ ...value, rotation: null }));
      yield* rotate(rotation.context, "size", response.text.slice(0, 4000));
      yield* deliverRotated(rotation);
    });
    const getState = Effect.fn("D4Agent.getState")(function* () {
      yield* captureDisplay();
      const state = yield* store.get;
      const config = yield* settings;
      const unavailableReason = modelAvailability(config, yield* providers.getProviders);
      const thread =
        state.threadId === null
          ? null
          : yield* threads.getThreadShell(state.threadId).pipe(Effect.mapError(threadError));
      const available = thread !== null && thread.deletedAt === null;
      const references = (state.transcript ?? []).some((entry) => entry.links.length > 0)
        ? yield* referenceCatalog
        : [];
      const transcript = (state.transcript ?? []).map((entry) => ({
        ...entry,
        links: entry.links.map((link) => {
          const target = references.find(
            (reference) =>
              reference.threadId === link.threadId && reference.projectId === link.projectId,
          );
          return target &&
            target.projectId &&
            projectContentInScope(state.brainContext, config, target.projectId)
            ? { label: target.title, threadId: target.threadId, projectId: target.projectId }
            : { label: link.label, threadId: null, projectId: null };
        }),
      }));
      return {
        openSessions: (state.sessions ?? []).map(
          ({
            context,
            threadId,
            providerSessionId,
            lastActivityAt,
            inputTokens,
            contextWindow,
          }) => ({
            context,
            threadId,
            providerSessionId,
            lastActivityAt,
            inputTokens,
            contextWindow,
          }),
        ),
        transcript,
        chatThreadIds: state.chatThreadIds ?? [],
        brainContext: state.brainContext,
        contextChangedAt: state.contextChangedAt,
        sessionChangeReason: state.sessionChangeReason ?? null,
        ctoAskInFlight: ctoAsk !== undefined,
        memoryProposals: yield* Effect.tryPromise({
          try: () => brain.listProposals(state.brainContext),
          catch: storageError,
        }),
        otherContextProposalCounts: (yield* Effect.tryPromise({
          try: () => brain.proposalCounts(),
          catch: storageError,
        }))
          .filter((entry) => entry.context !== state.brainContext && entry.pending > 0)
          .map((entry) => ({ context: entry.context, count: entry.pending })),
        brainIndexes: yield* Effect.tryPromise({
          try: () =>
            brain.indexStatuses({ root: config.brainVaultPath, enabled: config.memoryEnabled }),
          catch: () => new D4AgentError({ reason: "context" }),
        }),
        threadId: available ? state.threadId : null,
        projectId: available ? state.projectId : null,
        modelAvailable: unavailableReason === null,
        unavailableReason,
        actionLog: actionSummaries(
          state.actions.filter(
            (record) =>
              record.context === state.brainContext &&
              (record.action.type === "cto-ask" ||
                record.action.type === "auto-archive" ||
                record.sessionId === null ||
                record.sessionId === state.threadId),
          ),
        ),
        systemHealth: cachedHealth(
          state,
          yield* settingsService.getSettings.pipe(Effect.mapError(storageError)),
        ),
        usage: state.usage,
      } satisfies D4AgentState;
    });
    const validateTarget = Effect.fn("D4Agent.validateTarget")(function* (action: D4AgentAction) {
      const { state, config } = yield* bound("context" in action ? action.context : undefined);
      if (action.type === "memory-propose") {
        if (state.brainContext === "Global") return yield* new D4AgentError({ reason: "context" });
        if (!config.memoryEnabled) return yield* new D4AgentError({ reason: "memory-unavailable" });
        return;
      }
      if (action.type === "cto-ask") {
        if (ctoAsk !== undefined) return yield* new D4AgentError({ reason: "busy" });
        if (state.brainContext !== "Dimaggi" || !config.ctoEnabled)
          return yield* new D4AgentError({ reason: "context" });
        return;
      }
      if (action.type === "auto-archive")
        return yield* new D4AgentError({ reason: "action-unavailable" });
      if (action.type === "pipeline" || action.type === "research") {
        yield* pipelines.prepare(action, state.brainContext);
        return;
      }
      if (action.type === "start") {
        if (
          !projectContentInScope(state.brainContext, config, action.projectId) ||
          action.projectId === state.projectId
        )
          return yield* new D4AgentError({ reason: "context" });
        return;
      }
      if (action.threadId === state.threadId)
        return yield* new D4AgentError({ reason: "action-unavailable" });
      const target = yield* threads
        .getThreadShell(action.threadId)
        .pipe(Effect.mapError(threadError));
      if (
        target === null ||
        target.deletedAt !== null ||
        target.runtimeMode !== "approval-required" ||
        target.projectId === state.projectId ||
        !projectContentInScope(state.brainContext, config, target.projectId)
      )
        return yield* new D4AgentError({ reason: "action-unavailable" });
      if (action.type === "answer") {
        const request = yield* projections
          .getRuntimeRequest(action.threadId, action.requestId)
          .pipe(Effect.mapError(threadError));
        if (request === undefined || request.kind !== "user_input" || request.status !== "pending")
          return yield* new D4AgentError({ reason: "request-not-answerable" });
      }
    });
    const execute = Effect.fn("D4Agent.execute")(function* (record: D4AgentActionRecord) {
      yield* validateTarget(record.action);
      const action = record.action;
      const { state, config } = yield* bound();
      if (
        record.context !== state.brainContext ||
        (record.sessionId !== null && record.sessionId !== state.threadId)
      )
        return yield* new D4AgentError({ reason: "context" });
      if (action.type === "auto-archive")
        return yield* new D4AgentError({ reason: "action-unavailable" });
      if (action.type === "pipeline" || action.type === "research" || action.type === "start") {
        const reason = modelAvailability(
          { ...config, modelSelection: action.modelSelection },
          yield* providers.getProviders,
        );
        if (reason !== null) return yield* new D4AgentError({ reason });
        const targetId = ThreadId.make(`d4-action:${record.id}`);
        yield* store.update((value) => ({
          ...value,
          agentThreads: [
            ...(value.agentThreads ?? []).filter((entry) => entry.threadId !== targetId),
            {
              threadId: targetId,
              projectId: action.projectId,
              context: state.brainContext,
              actionId: record.id,
              reportedAt: null,
              archivedAt: null,
              undoDisabled: false,
              scopeHash: contextScopeHash(state.brainContext, config),
              ...("pipelineId" in action
                ? {
                    pipelineId: action.pipelineId,
                    pipelineHash: (record.result as Pipelines.PreparedPipeline).scenarioHash,
                  }
                : {}),
            },
          ],
        }));
        if (action.type !== "start") {
          const prepared = yield* pipelines.prepare(action, state.brainContext);
          const approved = record.result as Pipelines.PreparedPipeline | undefined;
          if (approved?.scenarioHash !== prepared.scenarioHash)
            return yield* new D4AgentError({ reason: "action-unavailable" });
          return yield* pipelines.execute({
            actionId: record.id,
            context: state.brainContext,
            prepared,
          });
        }
      }
      if (action.type === "memory-propose") {
        if (state.threadId === null) return yield* new D4AgentError({ reason: "context" });
        return yield* Effect.tryPromise({
          try: () =>
            brain.propose({
              context: state.brainContext,
              text: action.text,
              sessionId: state.threadId!,
            }),
          catch: () => new D4AgentError({ reason: "context" }),
        }).pipe(Effect.tapError(memoryFailure));
      }
      if (action.type === "cto-ask") {
        const ask = cto
          .ask({
            context: state.brainContext,
            enabled: config.ctoEnabled,
            baseUrl: config.ctoBaseUrl,
            allowRemoteHost: process.env.D4_AGENT_CTO_ALLOW_REMOTE_HOST === "1",
            text: action.text,
            permissionMode: config.permissionMode,
            approved: true,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new D4AgentError({
                  reason: error.reason === "unreachable" ? "cto-unreachable" : "cto-response",
                }),
            ),
          );
        const run = Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* settingsService.subscribeChanges;
            const disabled = changes.pipe(
              Stream.filter((value) => !value.d4Agent.enabled || !value.d4Agent.ctoEnabled),
              Stream.runHead,
              Effect.flatMap((value) =>
                Option.isSome(value)
                  ? Effect.fail(new D4AgentError({ reason: "disabled" }))
                  : Effect.never,
              ),
            );
            const latestConfig = yield* settings;
            const result = yield* Effect.result(
              latestConfig.enabled && latestConfig.ctoEnabled
                ? Effect.raceFirst(ask, disabled)
                : Effect.fail(new D4AgentError({ reason: "disabled" })),
            );
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* store.get;
                const latest = yield* settings;
                const canPost =
                  result._tag === "Success" &&
                  latest.enabled &&
                  latest.ctoEnabled &&
                  current.threadId === record.sessionId &&
                  current.brainContext === record.context &&
                  current.contextScopeHash === contextScopeHash(current.brainContext, latest);
                const answer =
                  result._tag === "Success"
                    ? typeof result.success === "object" &&
                      result.success !== null &&
                      "reply" in result.success &&
                      typeof result.success.reply === "string"
                      ? result.success.reply
                      : yield* encodeDigest(result.success).pipe(Effect.mapError(storageError))
                    : result.failure.message;
                if (canPost && record.sessionId !== null) {
                  yield* threads
                    .dispatch({
                      type: "thread.system-message.record",
                      commandId: command(`cto-result:${record.id}`),
                      threadId: record.sessionId,
                      messageId: MessageId.make(`d4-cto:${record.id}`),
                      text: answer,
                      title: "CTO answer",
                    })
                    .pipe(Effect.mapError(threadError));
                }
                const resolvedAt = DateTime.formatIso(yield* DateTime.now);
                yield* store.update((value) => ({
                  ...value,
                  actions: value.actions.map((entry) =>
                    entry.id === record.id
                      ? {
                          ...entry,
                          status:
                            result._tag === "Success" ? ("executed" as const) : ("failed" as const),
                          resolvedAt,
                          result: D4AgentStore.ctoPreview(
                            `${canPost ? "Posted to chat" : "Action log only"}: ${answer}`,
                          ),
                        }
                      : entry,
                  ),
                }));
              }),
            );
          }),
        ).pipe(
          Effect.onInterrupt(() =>
            store
              .update((value) => ({
                ...value,
                actions: value.actions.map((entry) =>
                  entry.id === record.id
                    ? {
                        ...entry,
                        status: "failed" as const,
                        result: "CTO question cancelled; no automatic retry.",
                      }
                    : entry,
                ),
              }))
              .pipe(Effect.ignore),
          ),
          Effect.catch(() =>
            store
              .update((value) => ({
                ...value,
                actions: value.actions.map((entry) =>
                  entry.id === record.id
                    ? {
                        ...entry,
                        status: "failed" as const,
                        result: "CTO answer could not be posted; no automatic retry.",
                      }
                    : entry,
                ),
              }))
              .pipe(
                Effect.ignore,
                Effect.andThen(Effect.logWarning("d4 Agent CTO answer delivery failed")),
              ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (ctoAsk?.id === record.id) ctoAsk = undefined;
            }),
          ),
        );
        const fiber = yield* run.pipe(Effect.forkIn(serviceScope));
        ctoAsk = { id: record.id, fiber };
        return "Asked, answer will be posted.";
      }
      if (action.type === "start") {
        const config = yield* settings;
        const reason = modelAvailability(
          { ...config, modelSelection: action.modelSelection },
          yield* providers.getProviders,
        );
        if (reason !== null) return yield* new D4AgentError({ reason });
        const targetId = ThreadId.make(`d4-action:${record.id}`);
        yield* threads
          .dispatch({
            type: "thread.create",
            commandId: command(`action-create:${record.id}`),
            threadId: targetId,
            projectId: action.projectId,
            title: "d4 Agent task",
            modelSelection: action.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadError));
        yield* threads
          .sendToThread({
            projectId: action.projectId,
            threadId: targetId,
            commandId: command(`action:${record.id}`),
            messageId: MessageId.make(`d4-action:${record.id}`),
            text: action.text,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadError));
      } else {
        const target = yield* threads
          .getThreadShell(action.threadId)
          .pipe(Effect.mapError(threadError));
        if (target === null) return yield* new D4AgentError({ reason: "action-unavailable" });
        if (action.type === "send")
          yield* threads
            .sendToThread({
              projectId: target.projectId,
              threadId: action.threadId,
              commandId: command(`action:${record.id}`),
              messageId: MessageId.make(`d4-action:${record.id}`),
              text: action.text,
              attachments: [],
              mode: "queue",
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(Effect.mapError(threadError));
        else if (action.type === "interrupt")
          yield* threads
            .interruptThread({
              projectId: target.projectId,
              threadId: action.threadId,
              commandId: command(`action:${record.id}`),
            })
            .pipe(Effect.mapError(threadError));
        else
          yield* threads
            .dispatch({
              type: "runtime-request.respond",
              commandId: command(`action:${record.id}`),
              threadId: action.threadId,
              requestId: action.requestId,
              answers: Object.fromEntries(
                Object.entries(action.answers).map(([key, answers]) => [key, { answers }]),
              ),
            })
            .pipe(Effect.mapError(threadError));
      }
    });
    const resolveRecord = Effect.fn("D4Agent.resolveRecord")(function* (
      record: D4AgentActionRecord,
    ) {
      const result = yield* Effect.result(
        execute(record).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const resolved: D4AgentActionRecord = {
        ...record,
        status: result._tag === "Success" ? "executed" : "failed",
        resolvedAt: now,
        ...(result._tag === "Success" && result.success !== undefined
          ? { result: result.success }
          : {}),
      };
      yield* store.update((value) => ({
        ...value,
        actions: value.actions.map((entry) => (entry.id === record.id ? resolved : entry)),
      }));
      if (result._tag === "Failure") return yield* Effect.fail(result.failure);
      return resolved;
    });
    const requestAction = (action: D4AgentAction) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const config = yield* settings;
          if (!config.enabled) return yield* new D4AgentError({ reason: "disabled" });
          if (
            config.permissionMode === "read-only" &&
            !["send", "start", "pipeline", "research"].includes(action.type)
          )
            return yield* new D4AgentError({ reason: "read-only" });
          yield* validateAction(action).pipe(
            Effect.mapError(() => new D4AgentError({ reason: "action-unavailable" })),
          );
          yield* validateTarget(action);
          const state = yield* store.get;
          if (action.type === "send")
            action = {
              ...action,
              originalText: state.lastUserText ?? action.originalText ?? action.text,
            };
          const prepared =
            action.type === "pipeline" || action.type === "research"
              ? yield* pipelines.prepare(action, state.brainContext)
              : undefined;
          if (state.actions.filter((entry) => entry.status === "pending").length >= 50)
            return yield* new D4AgentError({ reason: "busy" });
          const automatic = !requiresActionApproval(config.permissionMode, action);
          const at = yield* Clock.currentTimeMillis;
          let automaticBudget: { scope: string; target: string; at: number } | undefined;
          if (automatic) {
            const own =
              state.threadId === null
                ? null
                : yield* threads.getThreadShell(state.threadId).pipe(Effect.mapError(threadError));
            const scope =
              own?.activeRunId == null
                ? undefined
                : "context" in action
                  ? `${own.activeRunId}:${action.type}`
                  : own.activeRunId;
            const target = actionTarget(action);
            // A persisted reservation is consumed before dispatch, including failed attempts.
            if (
              scope == null ||
              state.automaticActions.filter((entry) => entry.scope === scope).length >= 3 ||
              state.automaticActions.some(
                (entry) => entry.target === target && at - entry.at < 600_000,
              )
            )
              return yield* new D4AgentError({ reason: "busy" });
            automaticBudget = { scope, target, at };
          }
          const record: D4AgentActionRecord = {
            context: state.brainContext,
            sessionId: state.threadId,
            id: yield* randomUUID,
            action,
            ...(prepared === undefined ? {} : { result: prepared }),
            status: requiresActionApproval(config.permissionMode, action) ? "pending" : "approved",
            createdAt: DateTime.formatIso(yield* DateTime.now),
            resolvedAt: null,
          };
          const reservation = automaticBudget;
          yield* store.update((value) => ({
            ...value,
            automaticActions:
              reservation === undefined
                ? value.automaticActions
                : [
                    ...value.automaticActions.filter(
                      (entry) => entry.scope === reservation.scope || at - entry.at < 600_000,
                    ),
                    reservation,
                  ],
            actions: [
              ...value.actions.filter((entry) => entry.status === "pending"),
              ...value.actions.filter((entry) => entry.status !== "pending").slice(-199),
              record,
            ],
          }));
          return record.status === "pending" ? record : yield* resolveRecord(record);
        }),
      );
    const resolveAction = (input: D4AgentResolveActionInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* store.get;
          const record = state.actions.find((entry) => entry.id === input.actionId);
          if (record === undefined || record.status !== "pending")
            return yield* new D4AgentError({ reason: "action-unavailable" });
          const resolvedAt = DateTime.formatIso(yield* DateTime.now);
          if (input.decision === "deny")
            yield* store.update((value) => ({
              ...value,
              actions: value.actions.map((entry) =>
                entry.id === record.id ? { ...entry, status: "denied", resolvedAt } : entry,
              ),
            }));
          else {
            const config = yield* settings;
            if (
              !config.enabled ||
              (config.permissionMode === "read-only" &&
                !["send", "start", "pipeline", "research"].includes(record.action.type))
            )
              return yield* new D4AgentError({ reason: "read-only" });
            const action = record.action;
            if (input.sendOriginal && input.editedText !== undefined)
              return yield* new D4AgentError({ reason: "action-unavailable" });
            const edited =
              action.type === "send"
                ? {
                    ...record,
                    action: {
                      ...action,
                      text: input.sendOriginal
                        ? (action.originalText ?? action.text)
                        : (input.editedText ?? action.text),
                    },
                  }
                : record;
            yield* resolveRecord(edited);
          }
          return yield* getState();
        }),
      );
    const tick = lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* settings;
        if ((!config.enabled || !config.ctoEnabled) && ctoAsk !== undefined)
          yield* Fiber.interrupt(ctoAsk.fiber);
        yield* adoptLegacySession;
        yield* captureDisplay();
        yield* finishRotation();
        yield* maintainSessions();
        const current = yield* store.get;
        for (const entry of config.enabled ? (current.agentThreads ?? []) : []) {
          if (entry.archivedAt === null && !entry.undoDisabled) {
            const shell = yield* threads
              .getThreadShell(entry.threadId)
              .pipe(Effect.mapError(threadError));
            if (
              shell?.latestRunId != null &&
              shell.activeRunId === null &&
              shell.pendingRuntimeRequest === null &&
              (entry.reportedAt === null ||
                DateTime.toEpochMillis(shell.updatedAt) > Date.parse(entry.reportedAt))
            ) {
              const { projection } = yield* projections
                .getThreadSnapshotWindow(entry.threadId, { rowLimit: 40, userTurnLimit: 10 })
                .pipe(Effect.mapError(threadError));
              const completedRun = projection.runs.find((run) => run.id === shell.latestRunId);
              if (
                completedRun?.status === "completed" &&
                completedRun.completedAt !== null &&
                (entry.reportedAt === null ||
                  DateTime.toEpochMillis(completedRun.completedAt) > Date.parse(entry.reportedAt))
              ) {
                const at = DateTime.formatIso(yield* DateTime.now);
                const text = `Completed: ${shell.title}.`;
                yield* store.update((value) => ({
                  ...value,
                  transcript: [
                    ...(value.transcript ?? []),
                    {
                      id: `report:${entry.actionId}:${completedRun.id}`,
                      role: "system" as const,
                      text,
                      context: entry.context,
                      createdAt: at,
                      links: [
                        {
                          label: shell.title,
                          threadId: entry.threadId,
                          projectId: entry.projectId,
                        },
                      ],
                    },
                  ].slice(-200),
                  agentThreads: (value.agentThreads ?? []).map((record) =>
                    record.threadId === entry.threadId ? { ...record, reportedAt: at } : record,
                  ),
                }));
              }
            }
          }
          if (
            yield* lifecycle
              .archive(entry, config.agentThreadArchiveHours)
              .pipe(Effect.catch(() => Effect.succeed(false)))
          ) {
            const at = DateTime.formatIso(yield* DateTime.now);
            yield* store.update((value) => ({
              ...value,
              agentThreads: (value.agentThreads ?? []).map((record) =>
                record.threadId === entry.threadId ? { ...record, archivedAt: at } : record,
              ),
              actions: [
                ...value.actions,
                {
                  id: `archive:${entry.actionId}`,
                  context: entry.context,
                  sessionId: null,
                  action: { type: "auto-archive" as const, threadId: entry.threadId },
                  status: "executed" as const,
                  createdAt: at,
                  resolvedAt: at,
                },
              ],
            }));
          }
        }
        const health = yield* systemHealth();
        if (!config.enabled) return;
        const active = (yield* store.get).sessions?.find(
          (entry) => entry.threadId === current.threadId,
        );
        if (
          !(yield* store.get).rotation &&
          active?.contextWindow != null &&
          active.inputTokens >= (active.contextWindow * config.sessionBudgetPercent) / 100
        ) {
          const shell = yield* threads
            .getThreadShell(active.threadId)
            .pipe(Effect.mapError(threadError));
          if (shell?.activeRunId == null) yield* beginRotation("", true);
        }
        if ((yield* store.get).rotation || config.heartbeatMinutes === null) return;
        const state = yield* store.get;
        const currentDigest = yield* digest();
        const attentionKeys = [
          ...currentDigest.reports
            .filter((entry) => entry.attentionRequired)
            .map((entry) => entry.reportKey),
          ...health.filter((entry) => entry.status === "attention").map((entry) => entry.reportKey),
        ].sort();
        const thread =
          state.threadId === null
            ? null
            : yield* threads.getThreadShell(state.threadId).pipe(Effect.mapError(threadError));
        const now = yield* Clock.currentTimeMillis;
        if (
          !heartbeatDue({
            settings: config,
            now,
            lastAt: state.heartbeatAt,
            previousKeys: state.heartbeatKeys,
            attentionKeys,
            busy: thread?.activeRunId != null,
          })
        ) {
          // Clear recovered keys so a later episode can produce a summary.
          if (attentionKeys.length === 0 && state.heartbeatKeys.length > 0)
            yield* store.update((value) => ({ ...value, heartbeatKeys: [] }));
          return;
        }
        yield* send(
          {
            text: `Heartbeat: summarize these changed attention reports briefly.\n${yield* encodeDigest({ reportKeys: attentionKeys.filter((key) => !state.heartbeatKeys.includes(key)), system: health }).pipe(Effect.mapError(storageError))}`,
          },
          true,
          `heartbeat:${sha256Hex(attentionKeys.join("\n"))}`,
        ).pipe(Effect.provideService(D4AgentAccess.DispatchOrigin, "internal-heartbeat"));
        yield* store.update((value) => ({
          ...value,
          heartbeatAt: now,
          heartbeatKeys: attentionKeys,
        }));
      }),
    );
    return D4Agent.of({
      closeSession: ({ context }) =>
        lock.withPermits(1)(
          adoptLegacySession.pipe(Effect.andThen(close(context)), Effect.andThen(getState())),
        ),
      undoArchive: ({ actionId }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* store.get;
            const entry = state.agentThreads?.find(
              (record) =>
                `archive:${record.actionId}` === actionId && record.context === state.brainContext,
            );
            if (!entry) return yield* new D4AgentError({ reason: "action-unavailable" });
            yield* lifecycle.undo(entry);
            yield* store.update((value) => ({
              ...value,
              agentThreads: (value.agentThreads ?? []).map((record) =>
                record.threadId === entry.threadId ? { ...record, undoDisabled: true } : record,
              ),
              actions: value.actions.map((record) =>
                record.id === actionId ? { ...record, status: "denied" as const } : record,
              ),
            }));
            return yield* getState();
          }),
        ),
      listPipelines: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { state, config } = yield* bound();
            const availableProjects = yield* projects
              .listShells()
              .pipe(Effect.mapError(threadError));
            return {
              pipelines: yield* pipelines.list(state.brainContext),
              modelSelection: yield* selected,
              projects: availableProjects
                .filter(
                  (project) =>
                    project.id !== state.projectId &&
                    projectContentInScope(state.brainContext, config, project.id),
                )
                .map((project) => ({ projectId: project.id, title: project.title })),
            };
          }),
        ),
      resolveReference: (text) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { state, config } = yield* bound();
            return resolveAgentReference(
              text,
              (yield* referenceCatalog).filter(
                (entry) => referenceContext(entry, config) === state.brainContext,
              ),
            );
          }),
        ),
      newSession: () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* selected;
            yield* rotate((yield* store.get).brainContext, "new-session");
            return yield* ensure();
          }),
        ),
      resolveMemoryProposal: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { state } = yield* bound();
            yield* Effect.tryPromise({
              try: () => brain.resolveProposal(state.brainContext, input.proposalId, input.approve),
              catch: storageError,
            });
            return yield* getState();
          }),
        ),
      switchContext: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const context = yield* Schema.decodeUnknownEffect(D4BrainContext)(input.context).pipe(
              Effect.mapError(() => new D4AgentError({ reason: "context" })),
            );
            yield* selected;
            if ((yield* store.get).rotation) return yield* new D4AgentError({ reason: "busy" });
            yield* maintainSessions();
            if ((yield* store.get).brainContext !== context) yield* rotate(context);
            return yield* ensure();
          }),
        ),
      memorySearch: (input) =>
        Effect.gen(function* () {
          const { state, config } = yield* lock.withPermits(1)(bound(input.context));
          if (!config.memoryEnabled)
            return yield* new D4AgentError({ reason: "memory-unavailable" });
          const all = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
          const result = yield* Effect.tryPromise({
            try: () =>
              brain.search({
                root: config.brainVaultPath,
                context: state.brainContext,
                query: input.query,
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                embeddings: {
                  enabled: config.embeddingsEnabled,
                  baseUrl: config.embeddingBaseUrl ?? all.secondBrain.embeddings.baseUrl,
                  model: config.embeddingModel ?? all.secondBrain.embeddings.model,
                },
              }),
            catch: () => new D4AgentError({ reason: "context" }),
          }).pipe(Effect.tapError(memoryFailure));
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* bound(input.context);
              if (
                current.state.threadId !== state.threadId ||
                !current.config.memoryEnabled ||
                current.state.contextScopeHash !== state.contextScopeHash
              )
                return yield* new D4AgentError({ reason: "context" });
              return result;
            }),
          );
        }),
      memoryRead: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { state, config } = yield* bound(input.context);
            if (!config.memoryEnabled)
              return yield* new D4AgentError({ reason: "memory-unavailable" });
            return yield* Effect.tryPromise({
              try: () =>
                brain.read({
                  root: config.brainVaultPath,
                  context: state.brainContext,
                  path: input.path,
                }),
              catch: () => new D4AgentError({ reason: "context" }),
            }).pipe(Effect.tapError(memoryFailure));
          }),
        ),
      ctoRead: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { state, config } = yield* bound(input.context);
            if (state.brainContext !== "Dimaggi" || !config.ctoEnabled)
              return yield* new D4AgentError({ reason: "context" });
            if (input.operation !== "status" && input.operation !== "brief")
              return yield* new D4AgentError({ reason: "context" });
            return yield* cto[input.operation]({
              context: state.brainContext,
              enabled: config.ctoEnabled,
              baseUrl: config.ctoBaseUrl,
              allowRemoteHost: process.env.D4_AGENT_CTO_ALLOW_REMOTE_HOST === "1",
            }).pipe(
              Effect.mapError(
                (error) =>
                  new D4AgentError({
                    reason: error.reason === "unreachable" ? "cto-unreachable" : "cto-response",
                  }),
              ),
            );
          }),
        ),
      getIdentity: () =>
        store.get.pipe(
          Effect.map((state) =>
            state.identityReady && state.threadId !== null && state.projectId !== null
              ? { threadId: state.threadId, projectId: state.projectId }
              : state.retiringThreadId === null &&
                  state.projectId !== null &&
                  state.chatThreadIds?.at(-1)
                ? { threadId: state.chatThreadIds.at(-1)!, projectId: state.projectId }
                : null,
          ),
        ),
      getAction: ({ actionId }) =>
        store.get.pipe(
          Effect.map(
            (state) =>
              state.actions.find(
                (entry) =>
                  entry.id === actionId &&
                  entry.context === state.brainContext &&
                  (entry.action.type === "cto-ask" ||
                    entry.action.type === "auto-archive" ||
                    entry.sessionId === null ||
                    entry.sessionId === state.threadId),
              ) ?? null,
          ),
        ),
      getSystemHealth: () =>
        Effect.gen(function* () {
          const state = yield* store.get;
          const config = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
          return {
            threadId: state.identityReady ? state.threadId : null,
            systemHealth: cachedHealth(state, config),
          };
        }),
      getState,
      claimSystemAttention,
      ensureThread: () => lock.withPermits(1)(ensure()),
      sendMessage: (input) => lock.withPermits(1)(send(input)),
      resolveAction,
      requestAction,
      list: () => lock.withPermits(1)(list()),
      systemHealth: () => bound().pipe(Effect.andThen(systemHealth())),
      tick,
      readTail: (threadId, limit) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const visible = yield* scopedThreads();
            const { state, config } = yield* bound();
            if (
              !visible.some(
                (thread) =>
                  thread.id === threadId &&
                  projectContentInScope(state.brainContext, config, thread.projectId),
              )
            )
              return yield* new D4AgentError({ reason: "context" });
            return yield* projections
              .getThreadSnapshotWindow(threadId, {
                rowLimit: Math.min(40, Math.max(1, limit)),
                userTurnLimit: Math.min(20, Math.max(1, limit)),
              })
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.projection.messages
                    .slice(-Math.min(20, Math.max(1, limit)))
                    .map((message) => ({ role: message.role, text: message.text.slice(0, 4000) })),
                ),
                Effect.mapError(threadError),
              );
          }),
        ),
      start: () =>
        tick.pipe(
          Effect.catch(() => Effect.logWarning("d4 Agent heartbeat unavailable")),
          Effect.repeat(Schedule.spaced("15 seconds")),
          Effect.forkScoped,
          Effect.asVoid,
        ),
    });
  }),
);
