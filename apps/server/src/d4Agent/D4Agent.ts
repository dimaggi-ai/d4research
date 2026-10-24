import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { sha256Hex } from "@d4research/shared/hash";
import { randomUuidV4 as randomUUID } from "@d4research/provider-core/server/randomUuid";
import {
  CommandId,
  D4AgentError,
  MessageId,
  ProjectId,
  ThreadId,
  type D4AgentIdentity,
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
export const requiresActionApproval = (
  mode: D4AgentSettings["permissionMode"],
  action: D4AgentAction,
) => mode === "ask" || action.type === "send" || action.type === "start";

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
      targetId: action.type === "start" ? action.projectId : action.threadId,
      preview: (action.type === "send" || action.type === "start"
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
    const store = yield* D4AgentStore.D4AgentStore;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectService.ProjectService;
    const monitor = yield* AgentMonitor.AgentMonitorReactor;
    const probe = yield* SystemProbe.SystemProbe;
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
    const ensure = Effect.fn("D4Agent.ensureThread")(function* () {
      const selection = yield* selected;
      let state = yield* store.get;
      // Persist identity before commands so interrupted creation retries the same receipts.
      if (state.threadId === null || state.projectId === null) {
        const threadId = ThreadId.make(yield* randomUUID),
          projectId = ProjectId.make(yield* randomUUID);
        state = yield* store.update((value) => ({ ...value, threadId, projectId }));
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
      if (!state.identityReady) yield* store.update((value) => ({ ...value, identityReady: true }));
      return { threadId, projectId };
    });
    const send = Effect.fn("D4Agent.sendMessage")(function* (
      input: D4AgentSendInput,
      heartbeat = false,
      id?: string,
    ) {
      id ??= yield* randomUUID;
      const identity = yield* ensure();
      const modelSelection = yield* selected;
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
      return contentFreeDigest(
        yield* monitor.snapshot.pipe(Effect.mapError(threadError)),
        yield* Clock.currentTimeMillis,
        state.threadId,
      );
    });
    const list = Effect.fn("D4Agent.list")(function* () {
      const reports = yield* digest();
      const config = yield* settingsService.getSettings.pipe(Effect.mapError(storageError));
      const state = yield* store.get;
      const shell = yield* threads.getShellSnapshot().pipe(Effect.mapError(threadError));
      const topLevel = shell.threads.filter(
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
    let usageSnapshotCursor: string | undefined;
    const captureUsage = usageLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* store.get;
        if (state.threadId === null) return;
        const shell = yield* threads
          .getThreadShell(state.threadId)
          .pipe(Effect.mapError(threadError));
        if (shell === null) return;
        const snapshotCursor = `${shell.id}:${DateTime.formatIso(shell.updatedAt)}:${shell.latestRunId ?? ""}:${shell.activeRunId ?? ""}`;
        if (snapshotCursor === usageSnapshotCursor) return;
        const { projection: records } = yield* projections
          .getThreadSnapshotWindow(state.threadId, { rowLimit: 100, userTurnLimit: 30 })
          .pipe(Effect.mapError(threadError));
        const catalog = yield* providers.getProviders;
        const additions = records.providerTurns.flatMap((turn) => {
          if (
            turn.completedAt === null ||
            `${DateTime.formatIso(turn.completedAt)}:${turn.id}` <= state.usageCursor ||
            state.usage.some((entry) => entry.runId === turn.id)
          )
            return [];
          const attempt = records.attempts.find((candidate) => candidate.id === turn.runAttemptId);
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
                conversationId: state.threadId!,
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
                // Codex canonical usage defaults this unreported counter to zero.
                ...(driver === "codex" || counters?.cacheCreationTokens === undefined
                  ? {}
                  : { cacheCreationTokens: counters.cacheCreationTokens }),
              }),
            },
          ];
        });
        if (additions.length > 0)
          yield* store.update((value) => ({
            ...value,
            usage: [...value.usage, ...additions].slice(-100),
            usageCursor: additions
              .map((entry) => `${entry.recordedAt}:${entry.runId}`)
              .sort()
              .at(-1)!,
          }));
        usageSnapshotCursor = snapshotCursor;
      }),
    );
    const getState = Effect.fn("D4Agent.getState")(function* () {
      const state = yield* store.get;
      const unavailableReason = modelAvailability(yield* settings, yield* providers.getProviders);
      const thread =
        state.threadId === null
          ? null
          : yield* threads.getThreadShell(state.threadId).pipe(Effect.mapError(threadError));
      const available = thread !== null && thread.deletedAt === null;
      return {
        threadId: available ? state.threadId : null,
        projectId: available ? state.projectId : null,
        modelAvailable: unavailableReason === null,
        unavailableReason,
        actionLog: actionSummaries(state.actions),
        systemHealth: cachedHealth(
          state,
          yield* settingsService.getSettings.pipe(Effect.mapError(storageError)),
        ),
        usage: state.usage,
      } satisfies D4AgentState;
    });
    const validateTarget = Effect.fn("D4Agent.validateTarget")(function* (action: D4AgentAction) {
      const state = yield* store.get;
      if (action.type === "start") return;
      if (action.threadId === state.threadId)
        return yield* new D4AgentError({ reason: "action-unavailable" });
      const target = yield* threads
        .getThreadShell(action.threadId)
        .pipe(Effect.mapError(threadError));
      if (
        target === null ||
        target.deletedAt !== null ||
        target.runtimeMode !== "approval-required"
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
          if (config.permissionMode === "read-only")
            return yield* new D4AgentError({ reason: "read-only" });
          yield* validateAction(action).pipe(
            Effect.mapError(() => new D4AgentError({ reason: "action-unavailable" })),
          );
          yield* validateTarget(action);
          const state = yield* store.get;
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
            const scope = own?.activeRunId;
            const target = action.type === "start" ? action.projectId : action.threadId;
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
            id: yield* randomUUID,
            action,
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
            if (!config.enabled || config.permissionMode === "read-only")
              return yield* new D4AgentError({ reason: "read-only" });
            yield* resolveRecord(record);
          }
          return yield* getState();
        }),
      );
    const tick = lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* settings;
        yield* captureUsage;
        const health = yield* systemHealth();
        if (!config.enabled || config.heartbeatMinutes === null) return;
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
      getIdentity: () =>
        store.get.pipe(
          Effect.map((state) =>
            state.identityReady && state.threadId !== null && state.projectId !== null
              ? { threadId: state.threadId, projectId: state.projectId }
              : null,
          ),
        ),
      getAction: ({ actionId }) =>
        store.get.pipe(
          Effect.map((state) => state.actions.find((entry) => entry.id === actionId) ?? null),
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
      list,
      systemHealth,
      tick,
      readTail: (threadId, limit) =>
        projections
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
