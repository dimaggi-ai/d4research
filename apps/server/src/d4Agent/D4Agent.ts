import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
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
import {
  contextScopeHash,
  taskScopeHash,
  projectInScope,
  projectContentInScope,
  projectActionInScope,
} from "./brainScope.ts";
import { sha256Hex } from "@d4research/shared/hash";
import { randomUuidV4 as randomUUID } from "@d4research/provider-core/server/randomUuid";
import {
  canStartProviderTurn,
  CommandId,
  D4_BRAIN_CONTEXTS,
  supportsD4AgentDriver,
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
import {
  contentFreeDigest,
  heartbeatDue,
  modelAvailability,
  modelFacingReport,
  usageAttributes,
} from "./policy.ts";

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
      {
        readonly counts: Record<string, number>;
        readonly reports: ReadonlyArray<ReturnType<typeof modelFacingReport>>;
        readonly omitted: number;
        readonly monitorEnabled: boolean;
        readonly threads: ReadonlyArray<{
          readonly threadId: ThreadId;
          readonly title: string;
          readonly status: string;
          readonly report: ReturnType<typeof modelFacingReport> | null;
        }>;
        readonly omittedThreads: number;
      },
      D4AgentError
    >;
    readonly environment: () => Effect.Effect<D4AgentEnvironment, D4AgentError>;
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

export interface D4AgentEnvironment {
  readonly application: "d4research";
  readonly boundContext: D4BrainContext;
  readonly contexts: ReadonlyArray<{
    readonly context: D4BrainContext;
    // Null when the bound work context may not see another context's project metadata.
    readonly projects: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly title: string;
    }> | null;
  }>;
  readonly providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly displayName: string | null;
    readonly enabled: boolean;
    readonly status: string;
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly canRunD4Agent: boolean;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  }>;
  readonly d4Agent: {
    readonly modelSelection: ModelSelection | null;
    readonly permissionMode: D4AgentSettings["permissionMode"];
    readonly unavailableReason: D4AgentState["unavailableReason"];
  };
}

const validateAction = Schema.decodeUnknownEffect(D4AgentAction);
const encodeDigest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const storageError = (cause: unknown) => new D4AgentError({ reason: "storage", cause });
const threadError = (cause: unknown) => new D4AgentError({ reason: "thread", cause });
const AGENT_TITLE = "Nia";
const LEGACY_AGENT_TITLE = "d4 Agent";
const command = (id: string) => CommandId.make(`d4-agent:${id}`);
const actionTarget = (action: D4AgentAction) =>
  action.type === "switch-context"
    ? (action.threadId ?? action.projectId ?? "")
    : "projectId" in action
      ? action.projectId
      : "context" in action
        ? `${action.type}:${action.context}`
        : action.threadId;
export const requiresActionApproval = (
  mode: D4AgentSettings["permissionMode"],
  action: D4AgentAction,
) =>
  mode === "ask" ||
  // A context switch moves the user's words into another context's session, so only a human may approve it.
  action.type === "switch-context" ||
  action.type === "send" ||
  action.type === "start" ||
  action.type === "research" ||
  action.type === "pipeline";

// Per-session caches are keyed by thread id and must not outlive the session that filled them.
export function retainOpenSessions(
  caches: ReadonlyArray<Map<string, unknown>>,
  sessions: ReadonlyArray<{ readonly threadId: string }>,
): void {
  const open = new Set(sessions.map((session) => session.threadId));
  for (const cache of caches) for (const id of cache.keys()) if (!open.has(id)) cache.delete(id);
}

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
        : action.type === "switch-context"
          ? `Switch to ${action.targetContext ?? "?"}: ${action.title ?? actionTarget(action)}`
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

const REFERENCE_SCAN_LIMIT = 5000;
const REFERENCE_EVENT_TYPES = [
  "thread.created",
  "thread.metadata-updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
] as const;

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
    const events = yield* Effect.serviceOption(ApplicationEvents.OrchestrationEventStore);
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
    const retirementRetries = new Map<ThreadId, number>();
    const finishRetirement = Effect.fn("D4Agent.finishRetirement")(function* () {
      const state = yield* store.get;
      const pending = [
        ...(state.pendingRetirements ?? []),
        ...(state.retiringThreadId === null
          ? []
          : [
              {
                threadId: state.retiringThreadId,
                providerSessionId: state.retiringProviderSessionId ?? null,
              },
            ]),
      ];
      const at = yield* Clock.currentTimeMillis;
      for (const retirement of pending) {
        if ((retirementRetries.get(retirement.threadId) ?? 0) > at) continue;
        const result = yield* Effect.result(
          Effect.gen(function* () {
            // Revoke the retired provider even if thread archival is temporarily unavailable.
            if (retirement.providerSessionId) {
              if (Option.isNone(sessionManager))
                return yield* new D4AgentError({ reason: "storage" });
              yield* sessionManager.value
                .detach({
                  providerSessionId: ProviderSessionId.make(retirement.providerSessionId),
                  threadId: retirement.threadId,
                  revokeMcpCredential: true,
                })
                .pipe(Effect.mapError(threadError));
            }
            const previous = yield* threads
              .getThreadShell(retirement.threadId)
              .pipe(Effect.mapError(threadError));
            if (previous !== null && previous.deletedAt === null) {
              for (const type of ["thread.stop", "thread.archive"] as const)
                yield* threads
                  .dispatch({
                    type,
                    commandId: command(`context-${type}:${retirement.threadId}`),
                    threadId: retirement.threadId,
                  })
                  .pipe(
                    Effect.provideService(D4AgentAccess.DispatchOrigin, "authenticated-user"),
                    Effect.mapError(threadError),
                  );
            }
          }),
        );
        if (result._tag === "Failure") {
          retirementRetries.set(retirement.threadId, at + 30_000);
          yield* Effect.logWarning("d4 Agent session retirement will be retried");
          continue;
        }
        retirementRetries.delete(retirement.threadId);
        yield* store.update((value) => ({
          ...value,
          ...(value.retiringThreadId === retirement.threadId
            ? {
                retiringThreadId: null,
                retiringProviderSessionId: null,
              }
            : {}),
          pendingRetirements: (value.pendingRetirements ?? []).filter(
            (entry) => entry.threadId !== retirement.threadId,
          ),
        }));
      }
    });
    const appendDisplay = Effect.fn("D4Agent.appendDisplay")(function* (
      text: string,
      role: "user" | "system",
      id?: string,
    ) {
      const state = yield* store.get;
      // Rotation retries replay their notices; a stable id shows each notice once.
      if (id !== undefined && state.transcript?.some((entry) => entry.id === id)) return;
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
      if ((state.pendingRetirements?.length ?? 0) + (state.retiringThreadId === null ? 0 : 1) >= 32)
        return yield* new D4AgentError({ reason: "busy" });
      if (session.providerSessionId !== null) {
        if (Option.isNone(sessionManager)) return yield* new D4AgentError({ reason: "storage" });
        yield* sessionManager.value
          .detach({
            providerSessionId: ProviderSessionId.make(session.providerSessionId),
            threadId: session.threadId,
            revokeMcpCredential: true,
          })
          .pipe(Effect.mapError(threadError));
      }
      const closedAt = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((value) => {
        // A decided rotation outlives its source session; closing its destination abandons it.
        const abandoned =
          value.rotation &&
          (value.rotation.targetThreadId ?? value.rotation.threadId) === session.threadId
            ? value.rotation
            : null;
        return {
          ...value,
          pendingRetirements: [
            ...(value.pendingRetirements ?? []).filter(
              (entry) => entry.threadId !== session.threadId,
            ),
            {
              threadId: session.threadId,
              providerSessionId: null,
            },
          ],
          rotation: abandoned ? null : (value.rotation ?? null),
          ...(abandoned && !abandoned.heartbeat
            ? {
                transcript: [
                  ...(value.transcript ?? []),
                  {
                    id: `rotation-dropped:${abandoned.deliveryId ?? abandoned.messageId}`,
                    role: "system" as const,
                    text: `Not sent: the session closed before Nia could deliver your message. Send it again if you still need it: ${abandoned.pendingText}`,
                    context: abandoned.context,
                    createdAt: closedAt,
                    links: [],
                  },
                ].slice(-200),
              }
            : {}),
          sessions: (value.sessions ?? []).filter((entry) => entry.threadId !== session.threadId),
          bindings: value.bindings.filter((entry) => entry.threadId !== session.threadId),
          ...(value.threadId === session.threadId ? { threadId: null, identityReady: false } : {}),
          actions: value.actions.map((entry) =>
            entry.sessionId === session.threadId && entry.status === "pending"
              ? { ...entry, status: "denied" as const }
              : entry,
          ),
        };
      });
      yield* finishRetirement();
    });
    const rotate = Effect.fn("D4Agent.rotate")(function* (
      context: D4BrainContext,
      reason: "context" | "new-session" | "size" = "context",
      seedSummary?: string,
      replacementThreadId?: ThreadId,
    ) {
      yield* finishRetirement();
      yield* adoptLegacySession;
      yield* captureDisplay();
      const config = yield* settings;
      const existing = (yield* store.get).sessions?.find((entry) => entry.context === context);
      const canResume =
        reason === "context" && existing?.scopeHash === contextScopeHash(context, config);
      if (existing && !canResume) yield* close(context);
      const threadId = canResume
        ? existing.threadId
        : (replacementThreadId ?? ThreadId.make(yield* randomUUID));
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
      const replaced = state.sessions?.find(
        (entry) => entry.context === state.brainContext && entry.threadId !== state.threadId,
      );
      if (replaced) yield* close(replaced.context);
      const threadId = state.threadId!,
        projectId = state.projectId!;
      const project = yield* projects
        .create({
          commandId: command(`project:${projectId}`),
          projectId,
          title: AGENT_TITLE,
          workspaceRoot: store.workspace,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: selection,
        })
        .pipe(Effect.mapError(threadError));
      // Installs created before the rename keep the old default title; rename it once.
      if (project.title === LEGACY_AGENT_TITLE)
        yield* projects
          .update({
            commandId: command(`project-title:${projectId}`),
            projectId,
            title: AGENT_TITLE,
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
            title: AGENT_TITLE,
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
      if (existing?.title === LEGACY_AGENT_TITLE)
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: command(`thread-title:${threadId}`),
            threadId,
            title: AGENT_TITLE,
          })
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
    let cachedReferences: AgentReference[] | undefined;
    let referenceSequence: number | undefined;
    let referenceSettings = "";
    let referenceProject: ProjectId | null = null;
    const referenceCatalog = Effect.gen(function* () {
      const state = yield* store.get;
      const config = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
      const settingsKey = yield* encodeDigest([
        config.dev.scenarios.map((entry) => entry.name),
        config.research.scenarios.map((entry) => entry.name),
        config.d4Agent.pipelineProjects,
      ]).pipe(Effect.mapError(storageError));
      let dirty =
        cachedReferences === undefined ||
        settingsKey !== referenceSettings ||
        state.projectId !== referenceProject;
      if (Option.isSome(events)) {
        const sequence = yield* events.value.latestApplicationSequence.pipe(
          Effect.mapError(threadError),
        );
        // This runs under the agent lock. A long gap rebuilds the catalog from the shell snapshot
        // instead of scanning every event since the last check.
        if (!dirty && referenceSequence !== undefined && sequence !== referenceSequence)
          dirty =
            sequence - referenceSequence > REFERENCE_SCAN_LIMIT ||
            (yield* events.value
              .hasApplicationEvents({
                afterSequence: referenceSequence,
                throughSequence: sequence,
                threadEventTypes: REFERENCE_EVENT_TYPES,
                excludeThreadId: state.threadId,
              })
              .pipe(Effect.mapError(threadError)));
        referenceSequence = sequence;
        if (!dirty) return cachedReferences!;
      }
      const shell = yield* threads.getShellSnapshot().pipe(Effect.mapError(threadError));
      const visible = shell.threads.filter(
        (entry) =>
          entry.deletedAt === null &&
          entry.archivedAt === null &&
          entry.projectId !== state.projectId,
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
      referenceSettings = settingsKey;
      referenceProject = state.projectId;
      cachedReferences = catalog;
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
      return projection;
    });
    const displayCursors = new Map<string, string>();
    const usageCursors = new Map<string, string>();
    const captureDisplay = Effect.fn("D4Agent.captureDisplay")(function* () {
      const state = yield* store.get;
      retainOpenSessions([sessionSnapshots, displayCursors, usageCursors], state.sessions ?? []);
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
      resolveReferences = true,
    ) {
      id ??= yield* randomUUID;
      yield* maintainSessions();
      if (!heartbeat && !resumedAfterRotation && (yield* store.get).rotation)
        return yield* new D4AgentError({ reason: "busy" });
      if (!heartbeat && resolveReferences) {
        const resolved = resolveAgentReference(input.text, yield* referenceCatalog);
        if (resolved.kind === "ambiguous") {
          const state = yield* store.get;
          const config = yield* settings;
          const candidates = resolved.candidates.filter(
            (entry) =>
              state.brainContext === "Global" ||
              referenceContext(entry, config) === state.brainContext,
          );
          const identity = yield* ensure();
          yield* appendDisplay(input.text, "user");
          yield* appendDisplay(
            candidates.length === 0
              ? "Which thread, project, or pipeline do you mean? Mention one at a time."
              : `Which thread, project, or pipeline do you mean? ${candidates
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
      const identity = yield* ensure();
      const modelSelection = yield* selected;
      const at = DateTime.formatIso(yield* DateTime.now);
      if (!heartbeat && !resumedAfterRotation) {
        yield* appendDisplay(input.text, "user", `d4-agent:${id}`);
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
        yield* beginRotation(input.text, heartbeat, id);
        return identity;
      }
      if (!heartbeat)
        yield* store.update((value) => ({
          ...value,
          userMessages: [
            ...(value.userMessages ?? []).filter((entry) => entry.messageId !== `d4-agent:${id}`),
            {
              threadId: identity.threadId,
              messageId: `d4-agent:${id}`,
              text: input.text,
            },
          ].slice(-200),
        }));
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
      const visibleReports = reports.reports.map(modelFacingReport);
      const byThread = new Map(visibleReports.map((report) => [report.threadId, report]));
      return {
        counts: reports.counts,
        reports: visibleReports,
        omitted: reports.omitted,
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
    const environment = Effect.fn("D4Agent.environment")(function* () {
      const { state, config } = yield* bound();
      const catalog = yield* providers.getProviders;
      const allProjects = (yield* projects.listShells().pipe(Effect.mapError(threadError))).filter(
        (project) => project.id !== state.projectId,
      );
      return {
        application: "d4research",
        boundContext: state.brainContext,
        contexts: D4_BRAIN_CONTEXTS.map((context) => ({
          context,
          projects:
            state.brainContext === "Global" || context === state.brainContext
              ? allProjects
                  .filter((project) => (config.projectContexts[project.id] ?? "Global") === context)
                  .map((project) => ({ projectId: project.id, title: project.title.slice(0, 256) }))
              : null,
        })),
        providers: catalog.map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? null,
          enabled: provider.enabled,
          status: provider.status,
          available: canStartProviderTurn(provider),
          unavailableReason: provider.unavailableReason ?? null,
          canRunD4Agent: supportsD4AgentDriver(provider.driver),
          models: provider.models
            .filter(
              (model) => !provider.updateRequiredModels?.some((entry) => entry.slug === model.slug),
            )
            .map((model) => ({ slug: model.slug, name: model.name })),
        })),
        d4Agent: {
          modelSelection: config.modelSelection,
          permissionMode: config.permissionMode,
          unavailableReason: modelAvailability(config, catalog),
        },
      } satisfies D4AgentEnvironment;
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
    const captureUsage = usageLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* store.get;
        retainOpenSessions([sessionSnapshots, displayCursors, usageCursors], state.sessions ?? []);
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
          // Turn input counters sum every API call in a turn; the budget needs the current fill.
          const usedTokens = currentUsage?.usedTokens;
          if (
            additions.length > 0 ||
            maxTokens !== session.contextWindow ||
            (usedTokens !== undefined && usedTokens !== session.inputTokens)
          )
            yield* store.update((value) => ({
              ...value,
              usage: [...value.usage, ...additions].slice(-100),
              sessions: (value.sessions ?? []).map((entry) =>
                entry.threadId === session.threadId
                  ? {
                      ...entry,
                      inputTokens: usedTokens ?? Math.max(entry.inputTokens, ...recordedInput),
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
      const state = yield* store.get;
      for (const session of state.sessions ?? []) {
        const shell = yield* threads
          .getThreadShell(session.threadId)
          .pipe(Effect.mapError(threadError));
        // The rotation record holds the only copy of an undelivered message. Automatic idle
        // cleanup never closes its source or destination; only an explicit close or disable
        // abandons it, and that path tells the user the message was not sent.
        const rotating =
          state.rotation != null &&
          (state.rotation.threadId === session.threadId ||
            state.rotation.targetThreadId === session.threadId);
        if (
          !config.enabled ||
          (!rotating &&
            config.sessionIdleMinutes !== null &&
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
      deliveryId?: string,
    ) {
      const state = yield* store.get;
      if (state.rotation || state.threadId === null || state.projectId === null) return;
      const summaryId = `d4-summary:${yield* randomUUID}`;
      const at = DateTime.formatIso(yield* DateTime.now);
      const pendingId = deliveryId ?? (yield* randomUUID);
      yield* store.update((value) => ({
        ...value,
        rotation: {
          threadId: state.threadId!,
          context: state.brainContext,
          messageId: summaryId,
          pendingText,
          requestedAt: at,
          heartbeat,
          deliveryId: pendingId,
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
          rotation.deliveryId,
          true,
        ).pipe(Effect.provideService(D4AgentAccess.DispatchOrigin, "internal-server"));
      else yield* ensure();
    });
    // The rotation record holds the only copy of the pending message, so it is cleared only after
    // the replacement session accepted it. Every step reuses persisted ids and is safe to repeat.
    const finishRotation = Effect.fn("D4Agent.finishRotation")(function* () {
      const state = yield* store.get;
      const pending = state.rotation;
      if (!pending) return;
      let rotation = pending;
      if (rotation.targetThreadId === undefined) {
        const config = yield* settings;
        const source = state.sessions?.find(
          (session) => session.threadId === pending.threadId && session.context === pending.context,
        );
        let outcome: { seedSummary: string } | { notice: string };
        if (
          source?.scopeHash !== contextScopeHash(pending.context, config) ||
          state.threadId !== pending.threadId
        )
          outcome = {
            notice:
              "The context configuration changed. Started a new session without the previous summary.",
          };
        else {
          const projection = yield* projections
            .getThreadProjection(pending.threadId)
            .pipe(Effect.mapError(threadError));
          const run = projection.runs.find((entry) => entry.userMessageId === pending.messageId);
          const response = projection.messages.findLast(
            (message) => message.role === "assistant" && message.runId === run?.id,
          );
          if (run?.status === "completed" && response?.text.trim())
            outcome = { seedSummary: response.text.slice(0, 4000) };
          else if (
            run?.status === "failed" ||
            run?.status === "interrupted" ||
            (yield* Clock.currentTimeMillis) - Date.parse(pending.requestedAt) > 120_000
          )
            outcome = {
              notice: "The previous session could not produce a summary. Started a new session.",
            };
          else return;
        }
        const decided = {
          ...pending,
          ...outcome,
          deliveryId: pending.deliveryId ?? (yield* randomUUID),
          targetThreadId: ThreadId.make(yield* randomUUID),
        };
        yield* store.update((value) => ({
          ...value,
          rotation:
            value.rotation?.messageId === decided.messageId ? decided : (value.rotation ?? null),
        }));
        rotation = decided;
      }
      const decided = rotation;
      if ((yield* store.get).threadId !== decided.targetThreadId)
        yield* rotate(decided.context, "size", decided.seedSummary, decided.targetThreadId);
      if (decided.notice !== undefined)
        yield* appendDisplay(decided.notice, "system", `rotation:${decided.messageId}`);
      yield* deliverRotated(decided);
      yield* store.update((value) => ({
        ...value,
        rotation: value.rotation?.messageId === decided.messageId ? null : (value.rotation ?? null),
      }));
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
      const proposalCounts = yield* Effect.tryPromise({
        try: () => brain.proposalCounts(),
        catch: storageError,
      });
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
        memoryProposalCount:
          proposalCounts.find((entry) => entry.context === state.brainContext)?.pending ?? 0,
        otherContextProposalCounts: proposalCounts
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
    // Only Global may hand a request to a work context: Global content is shareable, work content is not.
    const switchTarget = Effect.fn("D4Agent.switchTarget")(function* (
      action: Extract<D4AgentAction, { type: "switch-context" }>,
    ) {
      const { state, config } = yield* bound();
      if (state.brainContext !== "Global") return yield* new D4AgentError({ reason: "context" });
      if ((action.threadId === undefined) === (action.projectId === undefined))
        return yield* new D4AgentError({ reason: "action-unavailable" });
      let projectId: ProjectId, title: string;
      if (action.threadId !== undefined) {
        const thread = yield* threads
          .getThreadShell(action.threadId)
          .pipe(Effect.mapError(threadError));
        if (thread === null || thread.deletedAt !== null)
          return yield* new D4AgentError({ reason: "action-unavailable" });
        projectId = thread.projectId;
        title = thread.title;
      } else {
        const project = (yield* projects.listShells().pipe(Effect.mapError(threadError))).find(
          (entry) => entry.id === action.projectId,
        );
        if (project === undefined) return yield* new D4AgentError({ reason: "action-unavailable" });
        projectId = project.id;
        title = project.title;
      }
      const targetContext = config.projectContexts[projectId] ?? "Global";
      if (projectId === state.projectId || targetContext === "Global")
        return yield* new D4AgentError({ reason: "action-unavailable" });
      return { targetContext, title: title.slice(0, 256) };
    });
    const validateTarget = Effect.fn("D4Agent.validateTarget")(function* (action: D4AgentAction) {
      if (action.type === "switch-context") {
        yield* switchTarget(action);
        return;
      }
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
          !projectActionInScope(state.brainContext, config, action.projectId) ||
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
        !projectActionInScope(state.brainContext, config, target.projectId)
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
      if (action.type === "switch-context") {
        // The mapping may have changed while the card waited for approval.
        const target = yield* switchTarget(action);
        if (target.targetContext !== action.targetContext || state.rotation)
          return yield* new D4AgentError({ reason: "context" });
        yield* rotate(target.targetContext);
        if (!action.originalText) return yield* ensure().pipe(Effect.asVoid);
        // The user approved this replay, so it is their message in the new session.
        return yield* send({ text: action.originalText }, false, undefined, false, false).pipe(
          Effect.provideService(D4AgentAccess.DispatchOrigin, "authenticated-user"),
          Effect.asVoid,
        );
      }
      if (action.type === "pipeline" || action.type === "research" || action.type === "start") {
        const reason = modelAvailability(
          { ...config, modelSelection: action.modelSelection },
          yield* providers.getProviders,
        );
        if (reason !== null) return yield* new D4AgentError({ reason });
        const targetId = ThreadId.make(`d4-action:${record.id}`);
        // Only active tasks count; settled ones are retired by the store bound.
        if ((state.agentThreads ?? []).filter((entry) => entry.settledAt == null).length >= 1000)
          return yield* new D4AgentError({ reason: "busy" });
        const register = Effect.gen(function* () {
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
                scopeHash: taskScopeHash(
                  state.brainContext,
                  config,
                  action.projectId,
                  "pipelineId" in action ? action.pipelineId : undefined,
                ),
                ...("pipelineId" in action
                  ? {
                      pipelineId: action.pipelineId,
                      pipelineHash: (record.result as Pipelines.PreparedPipeline).scenarioHash,
                    }
                  : {}),
              },
            ],
          }));
        });
        if (action.type !== "start") {
          const prepared = yield* pipelines.prepare(action, state.brainContext);
          const approved = record.result as Pipelines.PreparedPipeline | undefined;
          if (approved?.scenarioHash !== prepared.scenarioHash)
            return yield* new D4AgentError({ reason: "action-unavailable" });
          return yield* pipelines
            .execute({
              actionId: record.id,
              context: state.brainContext,
              prepared,
              onCreated: () => register.pipe(Effect.asVoid),
            })
            .pipe(
              Effect.tapError(() =>
                store.update((value) => D4AgentStore.revokeTasks(value, new Set([targetId]))),
              ),
            );
        }
        yield* threads
          .dispatch({
            type: "thread.create",
            commandId: command(`action-create:${record.id}`),
            threadId: targetId,
            projectId: action.projectId,
            title: "Nia task",
            modelSelection: action.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadError));
        yield* register;
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
          .pipe(
            Effect.mapError(threadError),
            Effect.tapError(() =>
              store.update((value) => D4AgentStore.revokeTasks(value, new Set([targetId]))),
            ),
          );
        return;
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
      {
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
            !["send", "start", "pipeline", "research", "switch-context"].includes(action.type)
          )
            return yield* new D4AgentError({ reason: "read-only" });
          yield* validateAction(action).pipe(
            Effect.mapError(() => new D4AgentError({ reason: "action-unavailable" })),
          );
          yield* validateTarget(action);
          const state = yield* store.get;
          // The user's words of the turn that led to this draft, never text the agent wrote.
          const currentUserText = Effect.gen(function* () {
            const shell =
              state.threadId === null
                ? null
                : yield* threads.getThreadShell(state.threadId).pipe(Effect.mapError(threadError));
            if (shell?.activeRunId != null) {
              const message = yield* projections
                .getRunMessage(shell.id, shell.activeRunId)
                .pipe(Effect.mapError(threadError));
              return message?.createdBy === "user" ? message.text : undefined;
            }
            if ((yield* D4AgentAccess.ToolCaller) !== undefined) return undefined;
            return state.userMessages?.findLast((entry) => entry.threadId === state.threadId)?.text;
          });
          if (action.type === "send") {
            const originalText = yield* currentUserText;
            const { originalText: _untrustedOriginal, ...draft } = action;
            action = originalText === undefined ? draft : { ...draft, originalText };
          }
          if (action.type === "switch-context") {
            const { targetContext, title } = yield* switchTarget(action);
            // Replay only the current turn's request; older Global requests stay in Global.
            const originalText = (yield* currentUserText)?.slice(-16000) ?? "";
            action = {
              type: "switch-context",
              ...(action.threadId === undefined ? {} : { threadId: action.threadId }),
              ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
              targetContext,
              title,
              ...(originalText === "" ? {} : { originalText }),
            };
          }
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
                !["send", "start", "pipeline", "research", "switch-context"].includes(
                  record.action.type,
                ))
            )
              return yield* new D4AgentError({ reason: "read-only" });
            const action = record.action;
            if (
              input.sendOriginal &&
              (input.editedText !== undefined ||
                action.type !== "send" ||
                action.originalText === undefined)
            )
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
    const taskCursors = new Map<string, string>();
    const archiveCursors = new Map<string, string>();
    // Shells of tracked tasks only; null marks a tracked thread the projection no longer has.
    const taskShells = new Map<
      ThreadId,
      Effect.Success<ReturnType<typeof threads.getThreadShell>>
    >();
    let taskSequence: number | undefined;
    const tick = lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* settings;
        if ((!config.enabled || !config.ctoEnabled) && ctoAsk !== undefined)
          yield* Fiber.interrupt(ctoAsk.fiber);
        yield* finishRetirement();
        yield* adoptLegacySession;
        yield* captureDisplay();
        // A delivery that keeps failing must not stall monitoring; the next tick retries it.
        yield* finishRotation().pipe(
          Effect.catch(() => Effect.logWarning("Nia rotated message delivery will be retried")),
        );
        yield* maintainSessions();
        const current = yield* store.get;
        const tracked = config.enabled ? (current.agentThreads ?? []) : [];
        if (tracked.length > 0) {
          const sequence = Option.isSome(events)
            ? yield* events.value.latestApplicationSequence.pipe(Effect.mapError(threadError))
            : undefined;
          const ids = new Set(tracked.map((entry) => entry.threadId));
          let reload: Iterable<ThreadId> = [];
          if (
            Option.isNone(events) ||
            sequence === undefined ||
            taskSequence === undefined ||
            sequence - taskSequence > REFERENCE_SCAN_LIMIT
          ) {
            const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(threadError));
            taskShells.clear();
            for (const shell of [...snapshot.threads, ...snapshot.archivedThreads])
              if (ids.has(shell.id)) taskShells.set(shell.id, shell);
            for (const id of ids) if (!taskShells.has(id)) taskShells.set(id, null);
          } else if (sequence !== taskSequence) {
            reload = yield* events.value
              .changedThreadIds({
                afterSequence: taskSequence,
                throughSequence: sequence,
                threadIds: [...ids],
              })
              .pipe(Effect.mapError(threadError));
          }
          for (const id of new Set([...reload, ...[...ids].filter((id) => !taskShells.has(id))]))
            taskShells.set(
              id,
              yield* threads.getThreadShell(id).pipe(Effect.mapError(threadError)),
            );
          for (const id of taskShells.keys()) if (!ids.has(id)) taskShells.delete(id);
          taskSequence = sequence;
        }
        const shells = new Map(
          [...taskShells].flatMap(([id, shell]) => (shell === null ? [] : [[id, shell] as const])),
        );
        const removed = new Set<ThreadId>();
        // A deleted task also loses its approved scope; an archived one keeps it.
        const deleted = new Set<ThreadId>();
        const settled = new Map<ThreadId, boolean>();
        for (const entry of tracked) {
          const shell = shells.get(entry.threadId);
          if (shell === undefined || shell.deletedAt !== null) deleted.add(entry.threadId);
          if (
            shell === undefined ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            entry.archivedAt !== null
          ) {
            removed.add(entry.threadId);
            taskCursors.delete(entry.threadId);
            archiveCursors.delete(entry.threadId);
            continue;
          }
          const isSettled =
            shell.latestRunId != null &&
            shell.activeRunId === null &&
            shell.pendingRuntimeRequest === null &&
            (shell.pendingBackgroundTasks?.length ?? 0) === 0;
          if (isSettled !== (entry.settledAt != null)) settled.set(entry.threadId, isSettled);
          const cursor = `${DateTime.formatIso(shell.updatedAt)}:${shell.latestRunId}:${shell.activeRunId}`;
          if (!entry.undoDisabled && taskCursors.get(entry.threadId) !== cursor) {
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
          taskCursors.set(entry.threadId, cursor);
          const archiveDue =
            entry.reportedAt !== null &&
            config.agentThreadArchiveHours !== null &&
            (yield* Clock.currentTimeMillis) >=
              Date.parse(entry.reportedAt) + config.agentThreadArchiveHours * 3_600_000;
          const archiveCursor = `${cursor}:${entry.reportedAt}:${config.agentThreadArchiveHours}`;
          if (
            archiveDue &&
            !entry.undoDisabled &&
            archiveCursors.get(entry.threadId) !== archiveCursor
          ) {
            const archived = yield* lifecycle
              .archive(entry, config.agentThreadArchiveHours)
              .pipe(Effect.result);
            if (archived._tag === "Failure") continue;
            archiveCursors.set(entry.threadId, archiveCursor);
            if (!archived.success) continue;
            const at = DateTime.formatIso(yield* DateTime.now);
            yield* store.update((value) => ({
              ...value,
              agentThreads: (value.agentThreads ?? []).filter(
                (record) => record.threadId !== entry.threadId,
              ),
              actions: [
                ...value.actions,
                {
                  id: `archive:${entry.actionId}`,
                  result: { ...entry, archivedAt: at },
                  context: entry.context,
                  sessionId: null,
                  action: { type: "auto-archive" as const, threadId: entry.threadId },
                  status: "executed" as const,
                  createdAt: at,
                  resolvedAt: at,
                },
              ],
            }));
            taskCursors.delete(entry.threadId);
            archiveCursors.delete(entry.threadId);
          }
        }
        if (removed.size > 0 || settled.size > 0) {
          const settledAt = DateTime.formatIso(yield* DateTime.now);
          yield* store.update((value) => ({
            ...D4AgentStore.revokeTasks(value, deleted),
            agentThreads: (value.agentThreads ?? [])
              .filter((entry) => !removed.has(entry.threadId))
              .map((entry) => {
                const next = settled.get(entry.threadId);
                return next === undefined
                  ? entry
                  : { ...entry, settledAt: next ? settledAt : null };
              }),
          }));
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
        const changed = yield* encodeDigest({
          reports: currentDigest.reports
            .filter(
              (entry) => entry.attentionRequired && !state.heartbeatKeys.includes(entry.reportKey),
            )
            .map(modelFacingReport),
          system: health.map(({ reportKey: _reportKey, ...check }) => check),
        }).pipe(Effect.mapError(storageError));
        yield* send(
          { text: `Heartbeat: summarize these changed attention reports briefly.\n${changed}` },
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
            const record = state.actions.find(
              (entry) =>
                entry.id === actionId &&
                entry.context === state.brainContext &&
                entry.status === "executed" &&
                entry.action.type === "auto-archive",
            );
            const entry =
              record === undefined
                ? undefined
                : Schema.decodeUnknownOption(D4AgentStore.StoredAgentThread)(record.result);
            const legacy = state.agentThreads?.find(
              (entry) =>
                `archive:${entry.actionId}` === actionId && entry.context === state.brainContext,
            );
            const restored = entry !== undefined && Option.isSome(entry) ? entry.value : legacy;
            if (!restored) return yield* new D4AgentError({ reason: "action-unavailable" });
            yield* lifecycle.undo(restored);
            yield* store.update((value) => ({
              ...value,
              agentThreads: [
                ...(value.agentThreads ?? []).filter(
                  (entry) => entry.threadId !== restored.threadId,
                ),
                { ...restored, archivedAt: null, undoDisabled: true },
              ],
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
                    projectActionInScope(state.brainContext, config, project.id),
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
              : state.projectId !== null && state.chatThreadIds?.at(-1)
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
      sendMessage: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            // Checked before idle sessions close, so only a change made by another client or a
            // size rotation counts. A closed session is not stale: the send reopens the same context.
            const state = yield* store.get;
            if (input.expectedContext === undefined || input.expectedThreadId === undefined)
              return yield* new D4AgentError({ reason: "client-outdated" });
            if (
              input.expectedContext !== state.brainContext ||
              (input.expectedThreadId != null &&
                state.threadId !== null &&
                input.expectedThreadId !== state.threadId)
            )
              return yield* new D4AgentError({ reason: "stale" });
            return yield* send(input);
          }),
        ),
      resolveAction,
      requestAction,
      list: () => lock.withPermits(1)(list()),
      environment: () => lock.withPermits(1)(environment()),
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
