import { buildServerProvider } from "@d4research/provider-core/server/snapshotProbe";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Config from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  DEFAULT_D4_AGENT_SETTINGS,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ProjectId,
  ScheduledTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type AgentMonitorUpdate,
  type D4AgentGuardVerdict,
  type D4AgentSettings,
  type D4HostRoutinesState,
  type D4AgentSystemCheck,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2RuntimeRequest,
  type ServerProvider,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";
import * as Agent from "./D4Agent.ts";
import { evaluateTaskScope, isAllowedTaskMcpRequest } from "./D4AgentTaskScope.ts";
import { OsReleasePath } from "./hostFacts.ts";
import * as Store from "./D4AgentStore.ts";
import { contextScopeHash } from "./brainScope.ts";
import * as Access from "./D4AgentAccess.ts";
import { sha256Hex } from "@d4research/shared/hash";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake HTTP server records exactly which CTO endpoints the service requests.
import * as NodeHttp from "node:http";
import * as Probe from "./SystemProbe.ts";
import * as Inbox from "./OverviewInbox.ts";
import * as OverviewThreads from "./OverviewThreads.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ToolGuard from "./ToolGuardGate.ts";
import * as Pc from "./PcCommand.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Monitor from "../orchestration-v2/AgentMonitorReactor.ts";

const targetId = ThreadId.make("target");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "chosen" };
const now = DateTime.makeUnsafe(0);
const target: OrchestrationV2ThreadShell = {
  id: targetId,
  projectId: ProjectId.make("project"),
  title: "Private",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, rootThreadId: targetId, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const provider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T00:00:00Z",
  models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};

const fixture = (
  mode: D4AgentSettings["permissionMode"] = "read-only",
  providerAvailable = true,
  projectService?: Projects.ProjectService["Service"],
  workspace = "/isolated/d4-agent",
  monitorEnabled = true,
  overrides: Partial<D4AgentSettings> = {},
  store?: Store.D4AgentStore["Service"],
) =>
  Effect.gen(function* () {
    const attachmentConfig = Context.get(
      yield* Layer.buildWithScope(
        Config.layerTest(process.cwd(), { prefix: "nia-intake-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        yield* Scope.Scope,
      ),
      Config.ServerConfig,
    );
    const catalog = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      providerAvailable ? [provider] : [],
    );
    const state = yield* Ref.make<Store.StoredState>({
      retiringThreadId: null,
      brainContext: "Global",
      contextChangedAt: null,
      contextScopeHash: contextScopeHash("Global", { ...DEFAULT_D4_AGENT_SETTINGS, ...overrides }),
      bindings: [],
      identityReady: false,
      automaticActions: [],
      threadId: null,
      projectId: null,
      actions: [],
      usage: [],
      usageCursor: "",
      heartbeatAt: 0,
      heartbeatKeys: [],
      systemEpisodes: [],
      systemClaims: [],
    });
    const hostSnapshot = yield* Ref.make<D4HostRoutinesState>({
      status: "not-configured",
      routines: [],
    });
    const checks = yield* Ref.make<ReadonlyArray<D4AgentSystemCheck>>([
      {
        id: "root-disk",
        status: "ok",
        reportKey: "root-disk:ok",
        value: 50,
        notificationEligible: false,
      },
    ]);
    const inboxSnapshots = yield* Ref.make<ReadonlyArray<Inbox.OverviewSnapshot>>([]);
    const completedThreadRuns = yield* Ref.make<ReadonlyArray<OverviewThreads.TerminalRun>>([]);
    const scheduledRuns = yield* Ref.make<
      Effect.Success<ReturnType<ScheduledTasks.ScheduledTaskService["Service"]["completedRuns"]>>
    >([]);
    const failSystemMessage = yield* Ref.make(false);
    const systemMessageIds = yield* Ref.make<ReadonlyArray<string>>([]);
    const monitorUpdates = yield* Ref.make<ReadonlyArray<AgentMonitorUpdate>>([]);
    const guardVerdict = yield* Ref.make<D4AgentGuardVerdict>({
      decision: "allowed",
      rule: null,
      reason: null,
    });
    const guardCalls = yield* Ref.make<ReadonlyArray<ToolGuard.ToolGuardEnvelope>>([]);
    const agentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(null);
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([target]);
    const sends = yield* Ref.make<
      ReadonlyArray<Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0]>
    >([]);
    const sendLimits = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const failStop = yield* Ref.make(false);
    const failCreate = yield* Ref.make(false);
    const creates = yield* Ref.make<
      ReadonlyArray<{ readonly title: string; readonly runtimeMode: string }>
    >([]);
    const createModels = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const failSend = yield* Ref.make(false);
    const failSnapshot = yield* Ref.make(false);
    const eventRevision = yield* Ref.make(0);
    const request = yield* Ref.make<OrchestrationV2RuntimeRequest | undefined>(undefined);
    const dispatches = yield* Ref.make<ReadonlyArray<string>>([]);
    const lifecycleLimits = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const systemMessages = yield* Ref.make<
      ReadonlyArray<{ threadId: string; title: string; text: string }>
    >([]);
    const pcCommands = yield* Ref.make<ReadonlyArray<string>>([]);
    const scheduled = yield* Ref.make<
      ReadonlyArray<Parameters<ScheduledTasks.ScheduledTaskService["Service"]["upsert"]>[0]>
    >([]);
    const listedSchedules = yield* Ref.make<
      Effect.Success<ReturnType<ScheduledTasks.ScheduledTaskService["Service"]["list"]>>["tasks"]
    >([]);
    const enabledSchedules = yield* Ref.make<ReadonlyArray<{ id: string; enabled: boolean }>>([]);
    const unscheduled = yield* Ref.make<ReadonlyArray<string>>([]);
    const projection = yield* Ref.make<OrchestrationV2ThreadProjection>({
      thread: { ...target, lastVisitedAt: target.lastVisitedAt ?? null },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: now,
    });
    const reads = yield* Ref.make({
      updates: 0,
      snapshots: 0,
      probes: 0,
      shells: 0,
      catalogs: 0,
      eventChecks: 0,
    });
    const relevantEvents = yield* Ref.make(true);
    // null reports every tracked thread as changed.
    const changedThreads = yield* Ref.make<ReadonlyArray<ThreadId> | null>(null);
    let previousShells: ReadonlyArray<OrchestrationV2ThreadShell> | undefined;
    let revision = 0;
    const stateChanges = yield* PubSub.unbounded<Store.StoredState>();
    const settingsLayer = Settings.layerTest({
      d4Agent: {
        ...DEFAULT_D4_AGENT_SETTINGS,
        enabled: true,
        modelSelection,
        taskModelSelection: modelSelection,
        permissionMode: mode,
        systemProbeEnabled: true,
        ...overrides,
      },
      agentMonitor: {
        enabled: monitorEnabled,
        notificationsEnabled: true,
        notifyClasses: ["system"],
      },
    });
    const settings = Context.get(
      yield* Layer.buildWithScope(settingsLayer, yield* Scope.Scope),
      Settings.ServerSettingsService,
    );
    const layer = Agent.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            Store.D4AgentStore,
            store ?? {
              workspace,
              readHostRoutines: () => Ref.get(hostSnapshot),
              get: Ref.get(state),
              update: (f) =>
                Ref.update(reads, (r) => ({ ...r, updates: r.updates + 1 })).pipe(
                  Effect.andThen(Ref.updateAndGet(state, f)),
                  Effect.tap((value) => PubSub.publish(stateChanges, value)),
                ),
            },
          ),
          Layer.succeed(OverviewThreads.OverviewThreads, {
            readCompleted: () => Ref.get(completedThreadRuns),
          }),
          Layer.succeed(Inbox.OverviewInbox, {
            read: () =>
              Ref.get(inboxSnapshots).pipe(
                Effect.map((snapshots) => ({ snapshots, diagnostics: [] })),
              ),
          }),
          Layer.succeed(Probe.SystemProbe, {
            check: () =>
              Ref.update(reads, (r) => ({ ...r, probes: r.probes + 1 })).pipe(
                Effect.andThen(Ref.get(checks)),
              ),
          }),
          Layer.succeed(Settings.ServerSettingsService, settings),
          Layer.mock(ApplicationEvents.OrchestrationEventStore)({
            latestApplicationSequence: Effect.gen(function* () {
              const currentShells = yield* Ref.get(shells);
              if (currentShells !== previousShells) {
                previousShells = currentShells;
                revision++;
              }
              return revision + (yield* Ref.get(eventRevision));
            }),
            changedThreadIds: ({ threadIds }) =>
              Ref.get(changedThreads).pipe(Effect.map((changed) => changed ?? threadIds)),
            hasApplicationEvents: () =>
              Ref.update(reads, (r) => ({ ...r, eventChecks: r.eventChecks + 1 })).pipe(
                Effect.andThen(Ref.get(relevantEvents)),
              ),
          }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Ref.get(catalog),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: () => Ref.get(projection),
            getThreadShell: (id) =>
              Ref.update(reads, (r) => ({ ...r, shells: r.shells + 1 })).pipe(
                Effect.andThen(Ref.get(agentShell)),
                Effect.flatMap((own) =>
                  own?.id === id
                    ? Effect.succeed(own)
                    : Ref.get(shells).pipe(
                        Effect.map((all) => all.find((thread) => thread.id === id) ?? null),
                      ),
                ),
              ),
            getShellSnapshot: () =>
              Ref.update(reads, (r) => ({ ...r, catalogs: r.catalogs + 1 })).pipe(
                Effect.andThen(Ref.get(shells)),
                Effect.map((all) => ({
                  threads: all,
                  archivedThreads: [],
                  snapshotSequence: 0,
                  schemaVersion: 2 as const,
                })),
              ),
            sendToThread: (input) =>
              Effect.gen(function* () {
                if (yield* Ref.get(failSend))
                  return yield* Effect.fail({ reason: "fixture send failure" } as never);
                if ((yield* Ref.get(shells)).some((t) => t.id === input.threadId && t.archivedAt))
                  return yield* new Threads.ThreadManagementThreadArchivedError({
                    threadId: input.threadId,
                  });
                yield* Ref.update(sends, (all) => [...all, input]);
                const limit = yield* DispatchModeLimit;
                yield* Ref.update(sendLimits, (all) => [...all, limit?.runtimeMode]);
                return {
                  message: { attachments: input.attachments },
                  run: { id: `run-${String(input.commandId)}` },
                } as never;
              }),
            dispatch: (cmd) =>
              Effect.gen(function* () {
                if (cmd.type === "thread.stop" && (yield* Ref.get(failStop)))
                  return yield* Effect.fail({ reason: "fixture stop failure" } as never);
                yield* Ref.update(dispatches, (value) => [...value, cmd.type]);
                if (
                  cmd.type === "thread.unsettle" ||
                  cmd.type === "thread.snooze" ||
                  cmd.type === "thread.unsnooze"
                ) {
                  const limit = yield* DispatchModeLimit;
                  yield* Ref.update(lifecycleLimits, (all) => [...all, limit?.runtimeMode]);
                }
                if (cmd.type === "thread.system-message.record") {
                  yield* Ref.update(systemMessageIds, (ids) => [...ids, cmd.messageId]);
                  if (yield* Ref.get(failSystemMessage))
                    return yield* Effect.fail({
                      reason: "fixture system message failure",
                    } as never);
                }
                if (cmd.type === "thread.system-message.record")
                  yield* Ref.update(systemMessages, (all) => [
                    ...all,
                    { threadId: cmd.threadId, title: cmd.title ?? "", text: cmd.text },
                  ]);
                if (cmd.type === "thread.create") {
                  if (yield* Ref.get(failCreate))
                    return yield* Effect.fail({ reason: "fixture creation failure" } as never);
                  yield* Ref.update(creates, (all) => [
                    ...all,
                    { title: cmd.title, runtimeMode: cmd.runtimeMode },
                  ]);
                  yield* Ref.update(createModels, (all) => [...all, cmd.modelSelection]);
                  yield* Ref.update(shells, (all) => [
                    ...all,
                    { ...target, id: cmd.threadId, projectId: cmd.projectId },
                  ]);
                  yield* Ref.set(agentShell, {
                    ...target,
                    id: cmd.threadId,
                    projectId: cmd.projectId,
                  });
                }
                if (cmd.type === "thread.metadata.update" && cmd.title !== undefined) {
                  const title = cmd.title;
                  yield* Ref.update(agentShell, (own) =>
                    own?.id === cmd.threadId ? { ...own, title } : own,
                  );
                }
                if (cmd.type === "thread.archive" || cmd.type === "thread.unarchive") {
                  const archivedAt = cmd.type === "thread.archive" ? yield* DateTime.now : null;
                  yield* Ref.update(shells, (all) =>
                    all.map((thread) =>
                      thread.id === cmd.threadId ? { ...thread, archivedAt } : thread,
                    ),
                  );
                }
                return { sequence: 1, duplicate: false, storedEvents: [] };
              }),
            settleThread: (input) =>
              Effect.gen(function* () {
                assert.isFalse(input.byOwnAgent);
                yield* Ref.update(dispatches, (value) => [...value, "thread.settle"]);
                const limit = yield* DispatchModeLimit;
                yield* Ref.update(lifecycleLimits, (all) => [...all, limit?.runtimeMode]);
                return { sequence: 1 };
              }),
            interruptThread: () =>
              Ref.update(dispatches, (value) => [...value, "interrupt"]).pipe(
                Effect.as({ type: "no_active_run" as const }),
              ),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({
            getThreadRecords: () =>
              Ref.get(projection).pipe(
                Effect.map((value) => ({ runs: value.runs, messages: value.messages }) as never),
              ),
            getRunMessage: (_threadId, runId) =>
              Ref.get(projection).pipe(
                Effect.map((value) => {
                  const run = value.runs.find((entry) => entry.id === runId);
                  return value.messages.find((entry) => entry.id === run?.userMessageId);
                }),
              ),
            getRuntimeRequest: () => Ref.get(request),
            getThreadProjection: () => Ref.get(projection),
            getThreadSnapshotWindow: () =>
              Ref.get(failSnapshot).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail({ reason: "fixture snapshot failure" } as never)
                    : Ref.update(reads, (r) => ({ ...r, snapshots: r.snapshots + 1 })).pipe(
                        Effect.andThen(Ref.get(projection)),
                        Effect.map((value) => ({
                          schemaVersion: 2,
                          snapshotSequence: 1,
                          projection: value,
                        })),
                      ),
                ),
              ),
          }),
          projectService === undefined
            ? Layer.mock(Projects.ProjectService)({
                create: () => Effect.succeed({} as never),
                listShells: () => Effect.succeed([]),
              })
            : Layer.succeed(Projects.ProjectService, projectService),
          Layer.mock(Monitor.AgentMonitorReactor)({ snapshot: Ref.get(monitorUpdates) }),
          Layer.succeed(Pc.PcCommand, {
            run: (command) =>
              Ref.update(pcCommands, (all) => [...all, command]).pipe(
                Effect.as({ exitCode: 0, timedOut: false, output: "hi\n" }),
              ),
          }),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({
            completedRuns: () => Ref.get(scheduledRuns),
            upsert: (input) =>
              Ref.update(scheduled, (all) => [...all, input]).pipe(
                Effect.as({
                  task: {
                    ...input,
                    id: ScheduledTaskId.make("task-1"),
                    nextRunAt: "1970-01-01T01:00:00.000Z",
                  } as never,
                }),
              ),
            list: () => Ref.get(listedSchedules).pipe(Effect.map((tasks) => ({ tasks }))),
            setEnabled: (input) =>
              Ref.update(enabledSchedules, (all) => [...all, input]).pipe(
                Effect.as({ task: { id: input.id, enabled: input.enabled } as never }),
              ),
            delete: ({ id }) =>
              Ref.update(unscheduled, (all) => [...all, id]).pipe(Effect.as({ id })),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            checkWorktreeBase: () => Effect.void,
            launch: (input) =>
              Ref.update(launches, (all) => [...all, input]).pipe(
                Effect.andThen(
                  Ref.update(shells, (all) => [
                    ...all,
                    { ...target, id: input.threadId!, projectId: input.projectId },
                  ]),
                ),
                Effect.as({ threadId: input.threadId!, projection: {} as never, resumed: false }),
              ),
          }),
          Layer.succeed(ToolGuard.ToolGuardGate, {
            evaluate: (_url, envelope) =>
              Ref.update(guardCalls, (all) => [...all, envelope]).pipe(
                Effect.andThen(Ref.get(guardVerdict)),
              ),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(Config.ServerConfig, attachmentConfig)),
      Layer.provide(NodeServices.layer),
    );
    const scope = yield* Scope.Scope;
    const service = Context.get(yield* Layer.buildWithScope(layer, scope), Agent.D4Agent);
    // A fresh service instance over the same persisted state and threads, as after a server restart.
    const restart = Layer.buildWithScope(layer, scope).pipe(
      Effect.map((built) => Context.get(built, Agent.D4Agent)),
    );
    return {
      service,
      attachmentConfig,
      // A human send bound to the context and session the client currently shows.
      send: (input: Parameters<typeof service.sendMessage>[0]) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            service.sendMessage({
              expectedContext: current.brainContext,
              expectedThreadId: current.threadId,
              ...input,
            }),
          ),
        ),
      restart,
      state,
      stateChanges,
      settings,
      checks,
      hostSnapshot,
      request,
      dispatches,
      lifecycleLimits,
      systemMessages,
      inboxSnapshots,
      completedThreadRuns,
      scheduledRuns,
      failSystemMessage,
      systemMessageIds,
      pcCommands,
      scheduled,
      unscheduled,
      listedSchedules,
      enabledSchedules,
      projection,
      catalog,
      reads,
      agentShell,
      shells,
      sends,
      failStop,
      failCreate,
      creates,
      createModels,
      launches,
      failSend,
      failSnapshot,
      eventRevision,
      relevantEvents,
      changedThreads,
      monitorUpdates,
      guardVerdict,
      guardCalls,
      sendLimits,
    };
  });

it.effect(
  "new session retries retirement, releases the old session and rejects stale callers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      const first = yield* f.service.ensureThread();
      yield* f.send({ text: "old context secret" });
      const approval = yield* f.service.requestAction({ type: "interrupt", threadId: targetId });
      yield* Ref.set(f.failStop, true);
      const replacement = yield* f.service.newSession();
      assert.notEqual(replacement.threadId, first.threadId);
      assert.equal((yield* Ref.get(f.state)).pendingRetirements?.[0]?.threadId, first.threadId);
      assert.equal((yield* f.service.getIdentity())?.projectId, first.projectId);
      yield* f.send({ text: "Retirement must not block this message" });
      yield* Ref.set(f.failStop, false);
      yield* TestClock.adjust("30 seconds");
      const second = yield* f.service.ensureThread();
      assert.notEqual(second.threadId, first.threadId);
      assert.equal(second.projectId, first.projectId);
      assert.equal((yield* Ref.get(f.state)).retiringThreadId, null);
      assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
      assert.include(yield* Ref.get(f.dispatches), "thread.stop");
      assert.include(yield* Ref.get(f.dispatches), "thread.archive");
      assert.equal(
        (yield* Effect.result(
          f.service.list().pipe(Effect.provideService(Access.ToolCaller, first.threadId)),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          f.service.resolveAction({ actionId: approval.id, decision: "approve" }),
        ))._tag,
        "Failure",
      );
      yield* f.send({ text: "new context question" });
      const sent = yield* Ref.get(f.sends);
      assert.equal(sent.at(-1)?.threadId, second.threadId);
      assert.equal(sent.at(-1)?.text, "new context question");
      assert.notInclude(JSON.stringify(sent.at(-1)), "old context secret");
      assert.deepEqual(yield* f.service.switchContext({ context: "Global" }), second);
    }),
);

it.effect(
  "work-bound list and read-tail exclude sibling and unmapped projects before reading messages",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "YB", [ProjectId.make("other")]: "Dimaggi" },
      });
      yield* Ref.set(f.shells, [
        target,
        {
          ...target,
          id: ThreadId.make("sibling"),
          projectId: ProjectId.make("other"),
          title: "sibling secret",
        },
        {
          ...target,
          id: ThreadId.make("unmapped"),
          projectId: ProjectId.make("unmapped"),
          title: "unmapped secret",
        },
      ]);
      yield* f.service.switchContext({ context: "YB" });
      assert.deepEqual(
        (yield* f.service.list()).threads.map((thread) => thread.threadId),
        [targetId],
      );
      for (const id of ["sibling", "unmapped"])
        assert.equal(
          (yield* Effect.result(f.service.readTail(ThreadId.make(id), 10)))._tag,
          "Failure",
        );
      assert.equal((yield* Ref.get(f.reads)).snapshots, 0);
      yield* f.service.readTail(targetId, 10);
      assert.equal((yield* Ref.get(f.reads)).snapshots, 1);
      yield* f.service.switchContext({ context: "Global" });
      assert.equal((yield* f.service.list()).threads.length, 3);
    }),
);

it.effect.each(["read-only", "ask", "act"] as const)(
  "memory proposal permission matrix (%s) never changes vault bytes",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-memory-action-" });
        const vault = `${directory}/vault`;
        yield* fs.makeDirectory(`${vault}/Global`, { recursive: true });
        const note = "Neutral approved marker";
        const manifest = JSON.stringify({
          files: [{ path: "Global/method.md", sha256: sha256Hex(note) }],
        });
        yield* fs.writeFileString(`${vault}/Global/method.md`, note);
        yield* fs.writeFileString(`${vault}/Global/sources.json`, manifest);
        const f = yield* fixture(
          mode,
          true,
          undefined,
          `${directory}/state/d4-agent/workspace`,
          true,
          { memoryEnabled: true, brainVaultPath: vault },
        );
        yield* f.service.switchContext({ context: "YB" });
        yield* Ref.update(f.agentShell, (shell) =>
          shell ? { ...shell, activeRunId: RunId.make("proposal-run") } : shell,
        );
        const result = yield* Effect.result(
          f.service.requestAction({
            type: "memory-propose",
            context: "YB",
            text: "Review this neutral method",
          }),
        );
        const database = `${directory}/state/d4-agent/brain/YB.sqlite`;
        if (mode === "read-only") {
          assert.equal(result._tag, "Failure");
          assert.isFalse(yield* fs.exists(database));
        } else {
          assert.equal(result._tag, "Success");
          if (result._tag === "Success") {
            assert.equal(result.success.status, mode === "ask" ? "pending" : "executed");
            if (mode === "ask") {
              assert.isFalse(yield* fs.exists(database));
              yield* f.service.resolveAction({ actionId: result.success.id, decision: "approve" });
            }
            const saved = yield* f.service.getAction({ actionId: result.success.id });
            assert.deepInclude(saved?.result, { context: "YB", status: "pending" });
            assert.isTrue(yield* fs.exists(database));
          }
        }
        assert.equal(yield* fs.readFileString(`${vault}/Global/method.md`), note);
        assert.equal(yield* fs.readFileString(`${vault}/Global/sources.json`), manifest);
        assert.deepEqual((yield* fs.readDirectory(vault)).sort(), ["Global"]);
        assert.equal(
          (yield* Effect.result(f.service.memoryRead({ context: "YB", path: "Global/method.md" })))
            ._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(f.service.memorySearch({ context: "YB", query: "marker" })))._tag,
          "Failure",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("read-only blocks every action before a side effect", () =>
  Effect.gen(function* () {
    const { service, dispatches, state } = yield* fixture();
    const result = yield* Effect.result(
      service.requestAction({ type: "interrupt", threadId: targetId }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "read-only");
    assert.deepEqual(yield* Ref.get(dispatches), []);
    assert.deepEqual((yield* Ref.get(state)).actions, []);
  }),
);

it.effect("ask persists a pending action and executes only once after user approval", () =>
  Effect.gen(function* () {
    const { service, dispatches, state } = yield* fixture("ask");
    const action = yield* service.requestAction({ type: "interrupt", threadId: targetId });
    assert.equal(action.status, "pending");
    assert.deepEqual(yield* Ref.get(dispatches), []);
    yield* service.resolveAction({ actionId: action.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(dispatches), ["interrupt"]);
    assert.equal((yield* Ref.get(state)).actions[0]?.status, "executed");
    const again = yield* Effect.result(
      service.resolveAction({ actionId: action.id, decision: "approve" }),
    );
    assert.equal(again._tag, "Failure");
    assert.deepEqual(yield* Ref.get(dispatches), ["interrupt"]);
  }),
);

it.effect("a pending card carries Nia's why and effect lines", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture("ask");
    const note = {
      why: "The System thread asked for a restart after the config change.",
      effect: "Runs systemctl --user restart caddy-auth.service on the desktop.",
    };
    const action = yield* service.requestAction({ type: "interrupt", threadId: targetId }, note);
    assert.deepEqual(action.note, note);
    assert.deepEqual((yield* service.getState()).actionLog[0]?.note, note);
  }),
);

it.effect("act holds a requested archive for one approval and Undo archive restores it", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    // Archiving starts no work, so a full-access thread the user started is a valid target.
    yield* Ref.update(f.shells, (all) =>
      all.map((thread) =>
        thread.id === targetId ? { ...thread, runtimeMode: "full-access" as const } : thread,
      ),
    );
    const archiveCommands = Ref.get(f.dispatches).pipe(
      Effect.map((all) => all.filter((type) => type.endsWith("archive"))),
    );
    const action = yield* f.service.requestAction({ type: "archive", threadId: targetId });
    assert.equal(action.status, "pending");
    assert.deepEqual(yield* archiveCommands, []);
    yield* f.service.resolveAction({ actionId: action.id, decision: "approve" });
    assert.deepEqual(yield* archiveCommands, ["thread.archive"]);
    assert.notEqual((yield* Ref.get(f.shells)).find((t) => t.id === targetId)?.archivedAt, null);
    yield* f.service.undoArchive({ actionId: action.id });
    assert.deepEqual(yield* archiveCommands, ["thread.archive", "thread.unarchive"]);
    assert.equal((yield* Ref.get(f.shells)).find((t) => t.id === targetId)?.archivedAt, null);
  }),
);

it.effect("resume waits for approval, then continues the interrupted pipeline run", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        {
          id: RunId.make("cut-run"),
          ordinal: 1,
          status: "cancelled",
          startedAt: "2026-10-27T16:00:00Z",
          userMessageId: "cut-message",
        },
      ] as unknown as typeof value.runs,
      messages: [
        { id: "cut-message", role: "user", text: "!research:default Audit the router" },
      ] as unknown as typeof value.messages,
    }));
    const action = yield* f.service.requestAction({ type: "resume", threadId: targetId });
    assert.equal(action.status, "pending");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    yield* f.service.resolveAction({ actionId: action.id, decision: "approve" });
    const sent = (yield* Ref.get(f.sends)).at(-1);
    assert.equal(sent?.threadId, targetId);
    assert.equal(String(sent?.commandId), "pipeline-resume:cut-run");
  }),
);

it.effect("archive refuses a thread that is still running", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    yield* Ref.update(f.shells, (all) =>
      all.map((thread) =>
        thread.id === targetId ? { ...thread, activeRunId: RunId.make("busy-run") } : thread,
      ),
    );
    const result = yield* Effect.result(
      f.service.requestAction({ type: "archive", threadId: targetId }),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual((yield* Ref.get(f.state)).actions, []);
  }),
);

it.effect("act still requires approval for arbitrary send instructions", () =>
  Effect.gen(function* () {
    const { service, dispatches } = yield* fixture("act");
    const action = yield* service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Publish this",
    });
    assert.equal(action.status, "pending");
    yield* service.resolveAction({ actionId: action.id, decision: "deny" });
    assert.deepEqual(yield* Ref.get(dispatches), []);
  }),
);

const nativeId = ThreadId.make("native-failed");
const native: OrchestrationV2ThreadShell = {
  ...target,
  id: nativeId,
  title: "Failed native run",
  createdBy: "user",
  creationSource: "web",
  lineage: { parentThreadId: null, rootThreadId: nativeId, relationshipToParent: null },
};

it.effect("Global resolves a thread the user started and sends to it after approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    yield* Ref.set(f.shells, [target, native]);
    assert.include(
      JSON.stringify(yield* f.service.resolveReference(`retry [[thread:${nativeId}]]`)),
      `"kind":"resolved"`,
    );
    const card = yield* f.service.requestAction({
      type: "send",
      threadId: nativeId,
      text: "Retry the failed step.",
    });
    assert.equal(card.status, "pending");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    const [sent] = yield* Ref.get(f.sends);
    assert.equal(sent?.threadId, nativeId);
    assert.equal(sent?.text, "Retry the failed step.");
  }),
);

it.effect("a work context cannot resolve or act on a native thread outside its projects", () =>
  Effect.gen(function* () {
    const dimaggi = ProjectId.make("dimaggi");
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [dimaggi]: "Dimaggi" },
    });
    yield* Ref.set(f.shells, [target, native]);
    yield* f.service.switchContext({ context: "Dimaggi" });
    assert.include(
      JSON.stringify(yield* f.service.resolveReference(`[[thread:${nativeId}]]`)),
      `"kind":"none"`,
    );
    for (const action of [
      { type: "send", threadId: nativeId, text: "Retry" },
      { type: "settle", threadId: nativeId },
    ] as const) {
      const result = yield* Effect.result(f.service.requestAction(action));
      assert.equal(result._tag === "Failure" && result.failure.reason, "action-unavailable");
    }
    assert.deepEqual(
      (yield* Ref.get(f.state)).actions.filter((entry) => entry.context === "Dimaggi"),
      [],
    );
  }),
);

it.effect.each([
  [{ type: "settle", threadId: nativeId }, "thread.settle", "Settled."],
  [{ type: "unsettle", threadId: nativeId }, "thread.unsettle", "Unsettled."],
  [
    { type: "snooze", threadId: nativeId, until: "1970-01-02T00:00:00.000Z" },
    "thread.snooze",
    "Snoozed until 1970-01-02T00:00:00.000Z.",
  ],
  [{ type: "unsnooze", threadId: nativeId }, "thread.unsnooze", "Unsnoozed."],
] as const)("%s waits for approval, then changes the native thread", ([action, type, result]) =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    // Lifecycle changes start no work, so a full-access thread without Tool Guard is in reach.
    yield* Ref.set(f.shells, [target, { ...native, runtimeMode: "full-access" }]);
    const card = yield* f.service.requestAction(action, {
      why: "The run failed and the user moved on.",
      effect: `Applies ${action.type} to Failed native run.`,
    });
    assert.equal(card.status, "pending");
    assert.deepEqual(yield* Ref.get(f.dispatches), []);
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.dispatches), [type]);
    assert.deepEqual(yield* Ref.get(f.lifecycleLimits), [undefined]);
    const record = (yield* Ref.get(f.state)).actions.find((entry) => entry.id === card.id);
    assert.equal(record?.status, "executed");
    assert.equal(record?.result, result);
  }),
);

it.effect(
  "lifecycle actions are refused in read-only, without a user turn, and for bad times",
  () =>
    Effect.gen(function* () {
      const readOnly = yield* fixture("read-only");
      yield* Ref.set(readOnly.shells, [target, native]);
      const denied = yield* Effect.result(
        readOnly.service.requestAction({ type: "settle", threadId: nativeId }),
      );
      assert.equal(denied._tag === "Failure" && denied.failure.reason, "read-only");

      const f = yield* fixture("act");
      yield* Ref.set(f.shells, [target, native]);
      const background = yield* Effect.result(
        f.service
          .requestAction({ type: "settle", threadId: nativeId })
          .pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat")),
      );
      assert.equal(
        background._tag === "Failure" && background.failure.reason,
        "action-unavailable",
      );
      for (const until of ["1969-12-31T00:00:00.000Z", "1972-01-01T00:00:00.000Z"]) {
        const result = yield* Effect.result(
          f.service.requestAction({ type: "snooze", threadId: nativeId, until }),
        );
        assert.equal(result._tag === "Failure" && result.failure.reason, "action-unavailable");
      }
      assert.deepEqual((yield* Ref.get(f.state)).actions, []);
      assert.deepEqual(yield* Ref.get(f.dispatches), []);
    }),
);

const switchRequest = "Add local DeepSeek to the CTO d4 provider list";
const switchFixture = (mode: "read-only" | "ask" | "act") =>
  Effect.gen(function* () {
    const f = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    const global = yield* f.send({ text: switchRequest });
    const card = yield* f.service.requestAction({
      type: "switch-context",
      threadId: targetId,
      targetContext: "Personal",
      title: "Spoofed",
      originalText: "Spoofed request",
    });
    return { ...f, global, card };
  });

it.effect.each(["read-only", "ask", "act"] as const)(
  "switch-context stays pending in %s mode with server-filled target and request",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* switchFixture(mode);
      assert.equal(f.card.status, "pending");
      assert.deepEqual(f.card.action, {
        type: "switch-context",
        threadId: targetId,
        targetContext: "Dimaggi",
        title: "Private",
        originalText: switchRequest,
      });
      assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
      assert.equal((yield* Ref.get(f.sends)).length, 1);
      assert.equal(
        (yield* f.service.getState()).actionLog[0]?.preview,
        "Switch to Dimaggi: Private",
      );
    }),
);

it.effect("approved switch-context rotates to the target context and replays the request", () =>
  Effect.gen(function* () {
    const f = yield* switchFixture("act");
    yield* f.service.resolveAction({ actionId: f.card.id, decision: "approve" });
    const state = yield* Ref.get(f.state);
    assert.equal(state.brainContext, "Dimaggi");
    assert.notEqual(state.threadId, f.global.threadId);
    const replay = (yield* Ref.get(f.sends)).at(-1);
    assert.equal(replay?.text, switchRequest);
    assert.equal(replay?.threadId, state.threadId);
    assert.equal(state.actions.find((entry) => entry.id === f.card.id)?.status, "executed");
  }),
);

it.effect("switch-context replays only the request of the current turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    yield* f.send({ text: "Older unrelated Global request" });
    yield* f.send({ text: "Another earlier request" });
    const current = yield* f.send({ text: switchRequest });
    const run = RunId.make("switch-run");
    const message = (yield* Ref.get(f.sends)).at(-1)!;
    yield* Ref.update(f.agentShell, (value) => value && { ...value, activeRunId: run });
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [{ id: run, userMessageId: message.messageId }] as unknown as typeof value.runs,
      messages: [
        { id: message.messageId, text: message.text, createdBy: "user" },
      ] as unknown as typeof value.messages,
    }));
    const card = yield* f.service
      .requestAction({ type: "switch-context", threadId: targetId })
      .pipe(Effect.provideService(Access.ToolCaller, current.threadId));
    assert.equal(card.action.type === "switch-context" && card.action.originalText, switchRequest);
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, switchRequest);
  }),
);

it.effect("denied switch-context leaves the context and session unchanged", () =>
  Effect.gen(function* () {
    const f = yield* switchFixture("ask");
    yield* f.service.resolveAction({ actionId: f.card.id, decision: "deny" });
    const state = yield* Ref.get(f.state);
    assert.equal(state.brainContext, "Global");
    assert.equal(state.threadId, f.global.threadId);
    assert.equal((yield* Ref.get(f.sends)).length, 1);
  }),
);

it.effect("switch-context moves requests only from Global into a work context", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    yield* Ref.set(f.shells, [
      target,
      { ...target, id: ThreadId.make("unmapped"), projectId: ProjectId.make("unmapped") },
    ]);
    yield* f.send({ text: switchRequest });
    const unmapped = yield* Effect.result(
      f.service.requestAction({ type: "switch-context", threadId: ThreadId.make("unmapped") }),
    );
    assert.equal(unmapped._tag === "Failure" && unmapped.failure.reason, "action-unavailable");
    yield* f.service.switchContext({ context: "YB" });
    const fromWork = yield* Effect.result(
      f.service.requestAction({ type: "switch-context", threadId: targetId }),
    );
    assert.equal(fromWork._tag === "Failure" && fromWork.failure.reason, "context");
    assert.deepEqual((yield* Ref.get(f.state)).actions, []);
  }),
);

it.effect("an answer cannot resolve a provider permission request", () =>
  Effect.gen(function* () {
    const { service, request, dispatches } = yield* fixture("act");
    yield* Ref.set(request, {
      id: RuntimeRequestId.make("permission"),
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    });
    const result = yield* Effect.result(
      service.requestAction({
        type: "answer",
        threadId: targetId,
        requestId: RuntimeRequestId.make("permission"),
        answers: { question: ["yes"] },
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "request-not-answerable");
    assert.deepEqual(yield* Ref.get(dispatches), []);
  }),
);

it.effect("unavailable model never starts a conversation or falls back", () =>
  Effect.gen(function* () {
    const { service, state, dispatches } = yield* fixture("read-only", false);
    const result = yield* Effect.result(service.ensureThread());
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "provider-unavailable");
    assert.equal((yield* Ref.get(state)).threadId, null);
    assert.deepEqual(yield* Ref.get(dispatches), []);
  }),
);

it.effect("system baseline is silent and repeated episodes get new durable claims", () =>
  Effect.gen(function* () {
    const { service, checks, state } = yield* fixture();
    yield* Ref.set(checks, [
      {
        id: "root-disk",
        status: "attention",
        reportKey: "root-disk:attention",
        value: 95,
        notificationEligible: false,
      },
    ]);
    const baseline = yield* service.systemHealth();
    assert.isFalse(baseline[0]!.notificationEligible);
    yield* Ref.set(checks, [
      {
        id: "root-disk",
        status: "ok",
        reportKey: "root-disk:ok",
        value: 50,
        notificationEligible: false,
      },
    ]);
    yield* service.systemHealth();
    yield* TestClock.adjust("1 second");
    yield* Ref.set(checks, [
      {
        id: "root-disk",
        status: "attention",
        reportKey: "root-disk:attention",
        value: 95,
        notificationEligible: false,
      },
    ]);
    const episode = (yield* service.systemHealth())[0]!;
    assert.isTrue(episode.notificationEligible);
    const claims = yield* Effect.all(
      [
        service.claimSystemAttention({ reportKey: episode.reportKey, clientId: "one" }),
        service.claimSystemAttention({ reportKey: episode.reportKey, clientId: "one" }),
      ],
      { concurrency: 2 },
    );
    assert.equal(claims.filter((entry) => entry.claimed).length, 1);
    assert.equal((yield* Ref.get(state)).systemClaims.length, 1);
    yield* TestClock.adjust("6 minutes");
    assert.isFalse(
      (yield* service.claimSystemAttention({ reportKey: episode.reportKey, clientId: "two" }))
        .claimed,
    );
  }),
);

it.effect.each([
  { driver: "codex", cacheCreationTokens: 0 },
  { driver: "claudeAgent", cacheCreationTokens: 0 },
  { driver: "claudeAgent", cacheCreationTokens: 19 },
])(
  "101 completed turns retain the newest 100 without re-adding evicted usage on repeated reads ($driver cache-write $cacheCreationTokens)",
  ({ driver, cacheCreationTokens }) =>
    Effect.gen(function* () {
      const { service, state, projection, catalog } = yield* fixture();
      yield* Ref.set(catalog, [{ ...provider, driver: ProviderDriverKind.make(driver) }]);
      const runId = RunId.make("run"),
        attemptId = RunAttemptId.make("attempt"),
        providerThreadId = ProviderThreadId.make("native"),
        nodeId = NodeId.make("node");
      yield* Ref.update(state, (value) => ({
        ...value,
        threadId: targetId,
        projectId: target.projectId,
      }));
      yield* Ref.update(projection, (value): OrchestrationV2ThreadProjection => ({
        ...value,
        runs: [
          {
            id: runId,
            threadId: targetId,
            ordinal: 1,
            providerInstanceId: provider.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("user"),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: DateTime.makeUnsafe(101000),
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        attempts: [
          {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: provider.instanceId,
            providerThreadId,
            providerTurnId: null,
            reason: "initial",
            status: "completed",
            startedAt: now,
            completedAt: DateTime.makeUnsafe(101000),
          },
        ],
        providerTurns: Array.from({ length: 101 }, (_, index) => ({
          id: ProviderTurnId.make(`turn:${index}`),
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: index + 1,
          status: "completed",
          startedAt: DateTime.makeUnsafe(index * 1000),
          completedAt: DateTime.makeUnsafe((index + 1) * 1000),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 50,
            outputTokens: 10,
            cachedInputTokens: index === 0 ? 0 : 30,
            cacheCreationTokens,
            hasSubagents: false,
          },
        })),
      }));
      yield* service.tick;
      const first = yield* service.getState();
      assert.equal(first.usage.length, 100);
      assert.isFalse(first.usage.some((entry) => entry.runId === "turn:0"));
      assert.equal(first.usage[0]?.attributes["gen_ai.usage.cache_read.input_tokens"], 30);
      for (const usage of first.usage) {
        if (driver === "codex")
          assert.isFalse("gen_ai.usage.cache_creation.input_tokens" in usage.attributes);
        else
          assert.equal(
            usage.attributes["gen_ai.usage.cache_creation.input_tokens"],
            cacheCreationTokens,
          );
      }
      const cursor = (yield* Ref.get(state)).usageCursor;
      const second = yield* service.getState();
      assert.deepEqual(second.usage, first.usage);
      assert.equal((yield* Ref.get(state)).usageCursor, cursor);
    }),
);

it.effect("idle heartbeat skips usage snapshots and changed owned thread captures new usage", () =>
  Effect.gen(function* () {
    const { service, state, agentShell, projection, reads } = yield* fixture();
    const id = ThreadId.make("owned");
    yield* Ref.update(state, (value) => ({ ...value, threadId: id, projectId: target.projectId }));
    yield* Ref.set(agentShell, { ...target, id });
    yield* service.tick;
    assert.equal((yield* Ref.get(reads)).snapshots, 1);
    yield* service.tick;
    assert.equal((yield* Ref.get(reads)).snapshots, 1);
    const completedAt = DateTime.makeUnsafe(2000);
    const runId = RunId.make("changed-run");
    const attemptId = RunAttemptId.make("changed-attempt");
    yield* Ref.update(projection, (value) => ({
      ...value,
      runs: [{ id: runId, modelSelection } as (typeof value.runs)[number]],
      attempts: [{ id: attemptId, runId } as (typeof value.attempts)[number]],
      providerTurns: [
        {
          id: ProviderTurnId.make("changed-turn"),
          runAttemptId: attemptId,
          completedAt,
          startedAt: now,
          turnTokenUsage: { inputTokens: 17, outputTokens: 3 },
        } as (typeof value.providerTurns)[number],
      ],
    }));
    yield* Ref.set(agentShell, { ...target, id, updatedAt: completedAt, latestRunId: runId });
    yield* service.tick;
    assert.equal((yield* Ref.get(reads)).snapshots, 2);
    const usage = (yield* service.getState()).usage;
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.attributes["gen_ai.usage.input_tokens"], 17);
    yield* service.tick;
    assert.equal((yield* Ref.get(reads)).snapshots, 2);
  }),
);

it.effect.each([
  { name: "current context fill", contextUsage: true, rotates: false, recorded: 100 },
  {
    name: "summed turn input without context usage",
    contextUsage: false,
    rotates: true,
    recorded: 900,
  },
])("session budget uses the $name", ({ contextUsage, rotates, recorded }) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const own = yield* f.service.ensureThread();
    const completedAt = DateTime.makeUnsafe(2000);
    const runId = RunId.make("multi-call-run");
    const attemptId = RunAttemptId.make("multi-call-attempt");
    const providerThreadId = ProviderThreadId.make("multi-call-provider-thread");
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [{ id: runId, modelSelection } as (typeof value.runs)[number]],
      attempts: [{ id: attemptId, runId } as (typeof value.attempts)[number]],
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          contextUsage: contextUsage ? { usedTokens: 100, maxTokens: 1000 } : null,
        } as unknown as (typeof value.providerThreads)[number],
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("multi-call-turn"),
          providerThreadId,
          runAttemptId: attemptId,
          completedAt,
          startedAt: now,
          // Nine API calls each re-sent the same ~100-token context.
          turnTokenUsage: { inputTokens: 900, outputTokens: 30 },
        } as (typeof value.providerTurns)[number],
      ],
    }));
    yield* Ref.set(f.agentShell, {
      ...target,
      id: own.threadId,
      projectId: own.projectId,
      updatedAt: completedAt,
      latestRunId: runId,
      activeProviderThreadId: providerThreadId,
    });
    if (!contextUsage)
      yield* Ref.update(f.state, (value) => ({
        ...value,
        sessions: value.sessions!.map((session) => ({ ...session, contextWindow: 1000 })),
      }));
    yield* f.service.tick;
    const session = (yield* Ref.get(f.state)).sessions!.find(
      (entry) => entry.threadId === own.threadId,
    )!;
    assert.equal(session.inputTokens, recorded);
    assert.equal(session.contextWindow, 1000);
    assert.equal(
      (yield* Ref.get(f.sends)).some((send) => send.text.startsWith("Summarize this session")),
      rotates,
    );
  }),
);

const realProjectLayer = RuntimeLayer.layerProjectService.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(
    Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
      invalidate: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
    }),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(Settings.layerTest()),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "d4-agent-project-" })),
);
it.effect("ensureThread creates a project and thread in a fresh environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-fresh-" });
      const projects = yield* Projects.ProjectService;
      const store = yield* Store.D4AgentStore.pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory)))),
      );
      const f = yield* fixture("read-only", true, projects, store.workspace, true, {}, store);
      const initial = yield* store.get;
      assert.equal(initial.threadId, null);
      assert.equal(initial.projectId, null);
      assert.deepEqual(initial.sessions, []);

      const identity = yield* f.service.ensureThread();

      assert.isTrue(Option.isSome(yield* projects.getById(identity.projectId)));
      const shell = yield* Ref.get(f.agentShell);
      assert.equal(shell?.id, identity.threadId);
      assert.equal(shell?.projectId, identity.projectId);
      const state = yield* store.get;
      assert.equal(state.threadId, identity.threadId);
      assert.equal(state.projectId, identity.projectId);
      assert.isTrue(state.identityReady);
      assert.equal(state.sessions?.[0]?.threadId, identity.threadId);
      assert.deepEqual(yield* f.service.ensureThread(), identity);
    }),
  ).pipe(Effect.provide(realProjectLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "ensureThread creates a missing isolated workspace and retries the same owned project",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-workspace-" });
        const workspace = `${directory}/new/workspace`;
        assert.isFalse(yield* fs.exists(workspace));
        const projects = yield* Projects.ProjectService;
        const { service, dispatches, state } = yield* fixture(
          "read-only",
          true,
          projects,
          workspace,
        );
        const saved = {
          threadId: ThreadId.make("interrupted-owned-thread"),
          projectId: ProjectId.make("interrupted-owned-project"),
        };
        yield* Ref.update(state, (value) => ({ ...value, ...saved }));
        const incomplete = yield* service.getState();
        assert.equal(incomplete.threadId, null);
        assert.equal(incomplete.projectId, null);
        const first = yield* service.ensureThread();
        assert.deepEqual(first, saved);
        assert.isTrue(yield* fs.exists(workspace));
        const project = yield* projects.getById(first.projectId);
        assert.isTrue(Option.isSome(project));
        if (Option.isSome(project)) assert.equal(project.value.workspaceRoot, workspace);
        assert.deepEqual(yield* service.ensureThread(), first);
        assert.include(yield* Ref.get(dispatches), "thread.create");
      }),
    ).pipe(Effect.provide(realProjectLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ensure renames the old default project and chat titles to Nia once", () =>
  Effect.gen(function* () {
    const projectTitle = yield* Ref.make("d4 Agent");
    const updates = yield* Ref.make<ReadonlyArray<string>>([]);
    const projectService = {
      create: () => Ref.get(projectTitle).pipe(Effect.map((title) => ({ title }) as never)),
      update: (input: { readonly commandId: string; readonly title?: string }) =>
        Ref.update(updates, (all) => [...all, input.commandId]).pipe(
          Effect.andThen(Ref.set(projectTitle, input.title ?? "")),
          Effect.as({} as never),
        ),
      listShells: () => Effect.succeed([]),
    } as unknown as Projects.ProjectService["Service"];
    const f = yield* fixture("read-only", true, projectService);
    const first = yield* f.service.ensureThread();
    yield* Ref.update(f.agentShell, (own) => own && { ...own, title: "d4 Agent" });
    yield* f.service.ensureThread();
    assert.equal((yield* Ref.get(f.agentShell))?.title, "Nia");
    assert.equal(yield* Ref.get(projectTitle), "Nia");
    yield* f.service.ensureThread();
    assert.deepEqual(yield* Ref.get(updates), [`d4-agent:project-title:${first.projectId}`]);
    assert.equal(
      (yield* Ref.get(f.dispatches)).filter((type) => type === "thread.metadata.update").length,
      1,
    );
  }),
);

it.effect("ensure keeps a chat title the user chose", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.ensureThread();
    yield* Ref.update(f.agentShell, (own) => own && { ...own, title: "My assistant" });
    yield* f.service.ensureThread();
    assert.equal((yield* Ref.get(f.agentShell))?.title, "My assistant");
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.metadata.update");
  }),
);

it.effect("thread listing omits opaque report keys that heartbeats still track", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      heartbeatMinutes: 15,
    });
    yield* f.service.ensureThread();
    const reportKey = `dedupe:${'\\"nested\\"'.repeat(200)}`;
    yield* Ref.set(f.monitorUpdates, [
      {
        threadId: targetId,
        revision: 1,
        report: {
          schemaVersion: 1,
          runId: null,
          attemptId: null,
          classification: "needs_user",
          reason: "pending_request",
          attentionRequired: true,
          notificationEligible: true,
          reportKey,
          observedAt: "1970-01-01T00:00:00Z",
          runStatus: null,
          pendingRequestId: null,
        },
      },
    ]);
    const listed = yield* f.service.list();
    assert.deepEqual(listed.reports, [
      {
        threadId: targetId,
        classification: "needs_user",
        reason: "pending_request",
        attentionRequired: true,
        ageSeconds: 0,
      },
    ]);
    assert.deepEqual(listed.threads[0]?.report, listed.reports[0]);
    assert.notInclude(JSON.stringify(listed), "dedupe:");
    yield* TestClock.adjust("16 minutes");
    yield* f.service.tick;
    const overview = (yield* f.service.overview()).find((item) => item.source === "threads");
    assert.equal(overview?.deliveredRevision, overview?.revision);
    const heartbeat = (yield* Ref.get(f.sends)).at(-1)?.text ?? "";
    assert.include(heartbeat, "Overview is already visible");
    assert.include(heartbeat, "needs_user");
    assert.notInclude(heartbeat, "dedupe:");
    assert.notInclude(heartbeat, "reportKey");
  }),
);

it.effect(
  "environment describes contexts, providers and agent settings without thread content",
  () =>
    Effect.gen(function* () {
      const dimaggi = ProjectId.make("dimaggi-project");
      const unmapped = ProjectId.make("unmapped-project");
      const projectService = {
        create: () => Effect.succeed({} as never),
        listShells: () =>
          Effect.succeed([
            { id: dimaggi, title: "CTO d4" },
            { id: unmapped, title: "Notes" },
          ] as never),
      } as unknown as Projects.ProjectService["Service"];
      const f = yield* fixture("ask", true, projectService, "/isolated/d4-agent", true, {
        projectContexts: { [dimaggi]: "Dimaggi" },
      });
      yield* Ref.set(f.catalog, [
        provider,
        {
          ...provider,
          instanceId: ProviderInstanceId.make("deepseek"),
          driver: ProviderDriverKind.make("deepseek"),
          displayName: "DeepSeek",
          models: [
            { slug: "deepseek-local", name: "DeepSeek local", isCustom: false, capabilities: null },
          ],
        },
      ]);
      yield* f.service.ensureThread();
      const global = yield* f.service.environment();
      assert.equal(global.application, "d4research");
      assert.equal(global.boundContext, "Global");
      assert.deepEqual(global.contexts, [
        { context: "Global", projects: [{ projectId: unmapped, title: "Notes" }] },
        { context: "Personal", projects: [] },
        { context: "YB", projects: [] },
        { context: "Dimaggi", projects: [{ projectId: dimaggi, title: "CTO d4" }] },
      ]);
      assert.deepEqual(
        global.providers.map(({ instanceId, driver, available, canRunD4Agent, models }) => ({
          instanceId,
          driver,
          available,
          canRunD4Agent,
          models,
        })),
        [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            available: true,
            canRunD4Agent: true,
            models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
          },
          {
            instanceId: ProviderInstanceId.make("deepseek"),
            driver: ProviderDriverKind.make("deepseek"),
            available: true,
            canRunD4Agent: true,
            models: [
              {
                slug: "deepseek-local",
                name: "DeepSeek local",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      );
      assert.deepEqual(global.d4Agent, {
        modelSelection,
        taskModelSelection: modelSelection,
        defaultTaskModelSelection: modelSelection,
        permissionMode: "ask",
        unavailableReason: null,
      });
      assert.notInclude(JSON.stringify(global), target.title);
      yield* f.service.switchContext({ context: "YB" });
      const work = yield* f.service.environment();
      assert.equal(work.boundContext, "YB");
      assert.deepEqual(
        work.contexts.map(({ context, projects }) => [context, projects]),
        [
          ["Global", null],
          ["Personal", null],
          ["YB", []],
          ["Dimaggi", null],
        ],
      );
      assert.notInclude(JSON.stringify(work), "CTO d4");
    }),
);

it.effect("thread listing remains available with monitoring disabled", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", false);
    const listed = yield* service.list();
    assert.isFalse(listed.monitorEnabled);
    assert.deepEqual(listed.threads, [
      { threadId: targetId, title: "Private", status: "idle", report: null },
    ]);
  }),
);
it.effect("oversized answers are rejected before persistence or dispatch", () =>
  Effect.gen(function* () {
    const { service, state, dispatches } = yield* fixture("ask");
    const result = yield* Effect.result(
      service.requestAction({
        type: "answer",
        threadId: targetId,
        requestId: RuntimeRequestId.make("input"),
        answers: { question: ["x".repeat(64001)] },
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual((yield* Ref.get(state)).actions, []);
    assert.deepEqual(yield* Ref.get(dispatches), []);
  }),
);

it.effect("polling state never writes, probes, or loads conversation snapshots", () =>
  Effect.gen(function* () {
    const { service, state, reads } = yield* fixture();
    yield* Ref.update(state, (s) => ({ ...s, threadId: targetId, projectId: target.projectId }));
    yield* service.getState();
    yield* service.getState();
    assert.deepEqual(yield* Ref.get(reads), {
      updates: 0,
      snapshots: 0,
      probes: 0,
      shells: 2,
      catalogs: 0,
      eventChecks: 0,
    });
  }),
);

it.effect("state contains bounded unique summaries and full actions require detail fetch", () =>
  Effect.gen(function* () {
    const { service, state } = yield* fixture();
    const actions = Array.from({ length: 249 }, (_, i) => ({
      context: "Global" as const,
      sessionId: null,
      id: `action:${i}`,
      action: { type: "send" as const, threadId: targetId, text: "x".repeat(16000) },
      status: i < 50 ? ("pending" as const) : ("executed" as const),
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(i * 1000)),
      resolvedAt: null,
    }));
    yield* Ref.update(state, (s) => ({ ...s, actions }));
    const snapshot = yield* service.getState();
    assert.equal(snapshot.actionLog.length, 70);
    assert.equal(new Set(snapshot.actionLog.map((a) => a.id)).size, 70);
    assert.equal(snapshot.actionLog.filter((a) => a.status === "pending").length, 50);
    assert.isFalse("pendingActions" in snapshot);
    assert.isTrue(snapshot.actionLog.every((a) => "preview" in a && a.preview.length <= 256));
    assert.isBelow(JSON.stringify(snapshot).length, 40000);
    const full = yield* service.getAction({ actionId: "action:0" });
    assert.equal(full?.action.type, "send");
    if (full?.action.type === "send") assert.equal(full.action.text.length, 16000);
    assert.equal(yield* service.getAction({ actionId: "missing" }), null);
  }),
);

it.effect(
  "automatic actions serialize, enforce turn and target budgets, and survive service restart",
  () =>
    Effect.gen(function* () {
      const { service, state, agentShell } = yield* fixture("act");
      const remind = { type: "remind", text: "Stretch", at: "1970-01-01T03:00:00.000Z" } as const;
      const reminders = Effect.map(Ref.get(state), (s) => s.reminders?.length ?? 0);
      const agentId = ThreadId.make("agent");
      const runId = RunId.make("agent-run");
      yield* Ref.set(agentShell, { ...target, id: agentId, activeRunId: runId });
      yield* Ref.update(state, (s) => ({
        ...s,
        threadId: agentId,
        projectId: ProjectId.make("agent-project"),
        identityReady: true,
      }));
      const results = yield* Effect.all(
        Array.from({ length: 5 }, () => Effect.result(service.requestAction(remind))),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((r) => r._tag === "Success").length, 1);
      assert.equal(yield* reminders, 1);
      assert.equal((yield* Ref.get(state)).automaticActions.length, 1);
      const restarted = yield* fixture("act");
      yield* Ref.set(restarted.state, yield* Ref.get(state));
      yield* Ref.set(restarted.agentShell, yield* Ref.get(agentShell));
      assert.equal((yield* Effect.result(restarted.service.requestAction(remind)))._tag, "Failure");
      assert.equal(
        (yield* Ref.get(restarted.state)).automaticActions.length,
        (yield* Ref.get(state)).automaticActions.length,
      );
      yield* Ref.update(agentShell, (s) =>
        s === null ? null : { ...s, activeRunId: RunId.make("another-run") },
      );
      assert.equal((yield* Effect.result(service.requestAction(remind)))._tag, "Failure");
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction(remind);
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction(remind);
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction(remind);
      yield* TestClock.adjust("10 minutes");
      assert.equal((yield* Effect.result(service.requestAction(remind)))._tag, "Failure");
      assert.equal(yield* reminders, 4);
    }),
);

it.effect("identity and notification reads are pure and reserved identity is invisible", () =>
  Effect.gen(function* () {
    const { service, state, reads } = yield* fixture();
    yield* Ref.update(state, (s) => ({ ...s, threadId: targetId, projectId: target.projectId }));
    assert.equal(yield* service.getIdentity(), null);
    assert.equal((yield* service.getSystemHealth()).threadId, null);
    yield* Ref.update(state, (s) => ({ ...s, identityReady: true }));
    assert.deepEqual(yield* service.getIdentity(), {
      threadId: targetId,
      projectId: target.projectId,
    });
    assert.equal((yield* service.getSystemHealth()).threadId, targetId);
    assert.deepEqual(yield* Ref.get(reads), {
      updates: 0,
      snapshots: 0,
      probes: 0,
      shells: 0,
      catalogs: 0,
      eventChecks: 0,
    });
  }),
);

it.live.each(["read-only", "ask", "act"] as const)(
  "CTO questions enforce scoped approval before the fake server receives POST (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise(
            () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const instance = NodeHttp.createServer((request, response) => {
                  requests.push(`${request.method} ${request.url}`);
                  request.resume();
                  response.setHeader("content-type", "application/json");
                  response.end(JSON.stringify({ answer: "Fixture CTO answer" }));
                });
                instance.once("error", reject);
                instance.listen(0, "127.0.0.1", () => resolve(instance));
              }),
          ),
          (instance) =>
            Effect.promise(() => new Promise<void>((resolve) => instance.close(() => resolve()))),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("Expected fixture listener");
        const ctoBaseUrl = `http://127.0.0.1:${address.port}`;
        const f = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
          ctoEnabled: true,
          ctoBaseUrl,
        });
        yield* f.service.ensureThread();
        assert.equal(
          (yield* Effect.result(f.service.ctoRead({ context: "Global", operation: "status" })))
            ._tag,
          "Failure",
        );
        assert.deepEqual(requests, []);
        yield* f.service.switchContext({ context: "Dimaggi" });
        yield* Ref.update(f.agentShell, (shell) =>
          shell ? { ...shell, activeRunId: RunId.make("cto-run") } : shell,
        );
        yield* f.service.ctoRead({ context: "Dimaggi", operation: "status" });
        assert.deepEqual(requests, ["GET /api/status"]);
        const changed = yield* PubSub.subscribe(f.stateChanges);
        const action = yield* Effect.result(
          f.service.requestAction({
            type: "cto-ask",
            context: "Dimaggi",
            text: "What is the fixture status?",
          }),
        );
        if (mode === "read-only") {
          assert.equal(action._tag, "Failure");
          assert.deepEqual(requests, ["GET /api/status"]);
        } else if (action._tag === "Success") {
          if (mode === "ask") {
            assert.equal(action.success.status, "pending");
            assert.deepEqual(requests, ["GET /api/status"]);
            yield* f.service.resolveAction({ actionId: action.success.id, decision: "approve" });
          } else assert.equal(action.success.status, "executed");
          yield* Stream.fromSubscription(changed).pipe(
            Stream.filter((value) =>
              value.actions.some(
                (entry) =>
                  entry.id === action.success.id &&
                  typeof entry.result === "string" &&
                  entry.result.startsWith("Posted to chat"),
              ),
            ),
            Stream.runHead,
          );
          assert.deepEqual(requests, ["GET /api/status", "POST /api/chat"]);
          assert.include(
            String((yield* f.service.getAction({ actionId: action.success.id }))?.result),
            "Fixture CTO answer",
          );
          assert.include(yield* Ref.get(f.dispatches), "thread.system-message.record");
        } else assert.fail("Expected authorized CTO action");
        const disabled = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
          ctoBaseUrl,
        });
        yield* disabled.service.switchContext({ context: "Dimaggi" });
        const count = requests.length;
        assert.equal(
          (yield* Effect.result(
            disabled.service.ctoRead({ context: "Dimaggi", operation: "brief" }),
          ))._tag,
          "Failure",
        );
        assert.equal(requests.length, count);
      }),
    ),
);

it.effect.each(["YB", "Dimaggi", "Global"] as const)(
  "list and read-tail let Global read every project and keep work contexts apart (%s)",
  (context) =>
    Effect.gen(function* () {
      const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "YB", [ProjectId.make("dimaggi")]: "Dimaggi" },
      });
      const ids = [targetId, ThreadId.make("dimaggi-thread"), ThreadId.make("unmapped-thread")];
      yield* Ref.set(f.shells, [
        target,
        { ...target, id: ids[1]!, projectId: ProjectId.make("dimaggi") },
        { ...target, id: ids[2]!, projectId: ProjectId.make("unmapped") },
      ]);
      yield* f.service.switchContext({ context });
      assert.deepEqual(
        (yield* f.service.list()).threads.map((thread) => thread.threadId),
        context === "Global" ? ids : [context === "YB" ? ids[0] : ids[1]],
      );
      for (const [index, id] of ids.entries()) {
        const before = (yield* Ref.get(f.reads)).snapshots;
        const result = yield* Effect.result(f.service.readTail(id, 10));
        // Global reads every project's content; a work context reads only its own projects.
        const allowed = context === "Global" || index === (context === "YB" ? 0 : 1);
        assert.equal(result._tag, allowed ? "Success" : "Failure");
        assert.equal((yield* Ref.get(f.reads)).snapshots, before + (allowed ? 1 : 0));
      }
    }),
);

it.effect(
  "Global reads and drafts cards for mapped threads while its memory stays Global-only",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-global-read-" });
        const vault = `${directory}/vault`;
        for (const [context, relative] of [
          ["Global", "Global/method.md"],
          ["Dimaggi", "Dimaggi/State/current.md"],
        ] as const) {
          const text = `shared-query ${context} private-marker`;
          yield* fs.makeDirectory(`${vault}/${relative.slice(0, relative.lastIndexOf("/"))}`, {
            recursive: true,
          });
          yield* fs.writeFileString(`${vault}/${relative}`, text);
          yield* fs.writeFileString(
            `${vault}/${context}/${context === "Global" ? "" : "State/"}sources.json`,
            JSON.stringify({ files: [{ path: relative, sha256: sha256Hex(text) }] }),
          );
        }
        const dimaggi = ProjectId.make("dimaggi");
        const dimaggiThread = ThreadId.make("dimaggi-thread");
        const f = yield* fixture(
          "ask",
          true,
          undefined,
          `${directory}/state/d4-agent/workspace`,
          true,
          {
            memoryEnabled: true,
            brainVaultPath: vault,
            projectContexts: { [dimaggi]: "Dimaggi" },
          },
        );
        yield* Ref.set(f.shells, [target, { ...target, id: dimaggiThread, projectId: dimaggi }]);
        yield* f.service.ensureThread();
        yield* f.service.readTail(dimaggiThread, 10);
        assert.equal((yield* Ref.get(f.reads)).snapshots, 1);
        const dispatched = (yield* Ref.get(f.dispatches)).length;
        const search = yield* f.service.memorySearch({ context: "Global", query: "shared-query" });
        assert.include(JSON.stringify(search), "Global private-marker");
        assert.notInclude(JSON.stringify(search), "Dimaggi private-marker");
        for (const denied of [
          f.service.memorySearch({ context: "Dimaggi", query: "shared-query" }),
          f.service.memoryRead({ context: "Global", path: "Dimaggi/State/current.md" }),
          f.service.requestAction({ type: "memory-propose", context: "Global", text: "work note" }),
        ])
          assert.equal((yield* Effect.result(denied))._tag, "Failure");
        assert.deepEqual((yield* Ref.get(f.state)).actions, []);
        // Global may draft a card for a work-context thread; it waits for approval and loads no
        // Dimaggi memory.
        yield* f.service.requestAction({ type: "send", threadId: dimaggiThread, text: "Go" });
        const [card] = (yield* Ref.get(f.state)).actions;
        assert.equal(card?.status, "pending");
        assert.equal(card?.context, "Global");
        assert.include(
          JSON.stringify(yield* f.service.resolveReference(`[[thread:${dimaggiThread}]]`)),
          '"kind":"resolved"',
        );
        assert.equal((yield* Ref.get(f.dispatches)).length, dispatched);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["ask", "act"] as const)(
  "Global proposals are refused before and after reading thread text (%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
        memoryEnabled: true,
      });
      yield* f.service.ensureThread();
      for (const read of [false, true]) {
        if (read) yield* f.service.readTail(targetId, 1);
        const result = yield* Effect.result(
          f.service.requestAction({
            type: "memory-propose",
            context: "Global",
            text: "thread:target quoted content",
          }),
        );
        assert.equal(result._tag, "Failure");
        assert.equal((yield* Ref.get(f.state)).actions.length, 0);
      }
    }),
);

it.effect("unrelated mapping changes preserve a work session; membership changes rotate it", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "YB" },
    });
    const original = yield* f.service.switchContext({ context: "YB" });
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        projectContexts: { [target.projectId]: "YB", [ProjectId.make("unrelated")]: "Personal" },
      },
    });
    assert.equal((yield* f.service.ensureThread()).threadId, original.threadId);
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        projectContexts: { [target.projectId]: "Dimaggi" },
      },
    });
    assert.notEqual((yield* f.service.ensureThread()).threadId, original.threadId);
  }),
);

it.live.each(["unchanged", "context", "session", "disabled"] as const)(
  "CTO ask returns immediately and handles %s session before its delayed answer",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const received = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let posts = 0;
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const instance = NodeHttp.createServer((request, response) => {
                  posts++;
                  request.resume();
                  received.resolve();
                  void release.promise.then(() =>
                    response.end(JSON.stringify({ reply: "Delayed synthetic CTO answer" })),
                  );
                });
                instance.listen(0, "127.0.0.1", () => resolve(instance));
              }),
          ),
          (server) =>
            Effect.promise(() => {
              release.resolve();
              server.closeAllConnections();
              return new Promise<void>((resolve) => server.close(() => resolve()));
            }),
        );
        const address = server.address();
        if (!address || typeof address === "string") return yield* Effect.die("No fake address");
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-cto-async-" });
        const f = yield* fixture("act", true, undefined, `${directory}/d4-agent/workspace`, true, {
          ctoEnabled: true,
          ctoBaseUrl: `http://127.0.0.1:${address.port}`,
          memoryEnabled: true,
        });
        const identity = yield* f.service.switchContext({ context: "Dimaggi" });
        yield* Ref.update(f.agentShell, (shell) =>
          shell ? { ...shell, activeRunId: RunId.make("async-ask") } : shell,
        );
        const updates = yield* PubSub.subscribe(f.stateChanges);
        const question = yield* f.service.requestAction({
          type: "cto-ask",
          context: "Dimaggi",
          text: "Synthetic question",
        });
        assert.equal(question.result, "Asked, answer will be posted.");
        yield* Effect.promise(() => received.promise);
        assert.isTrue((yield* f.service.getState()).ctoAskInFlight);
        assert.equal(
          (yield* Effect.result(
            f.service.requestAction({ type: "cto-ask", context: "Dimaggi", text: "No duplicate" }),
          ))._tag,
          "Failure",
        );
        // Independent action budget: a CTO ask does not consume the memory-proposal allowance.
        assert.equal(
          (yield* f.service.requestAction({
            type: "memory-propose",
            context: "Dimaggi",
            text: "A scoped proposal",
          })).status,
          "executed",
        );
        assert.equal(
          (yield* Effect.result(
            f.service.requestAction({
              type: "memory-propose",
              context: "Dimaggi",
              text: "Too soon",
            }),
          ))._tag,
          "Failure",
        );
        if (change === "context") yield* f.service.switchContext({ context: "YB" });
        if (change === "session") yield* f.service.newSession();
        if (change === "disabled") {
          yield* f.settings.updateSettings({
            d4Agent: { ...(yield* f.settings.getSettings).d4Agent, enabled: false },
          });
          yield* f.service.tick;
        }
        release.resolve();
        const complete = yield* Stream.fromSubscription(updates).pipe(
          Stream.filter((state) =>
            state.actions.some(
              (entry) =>
                entry.id === question.id &&
                typeof entry.result === "string" &&
                entry.result !== "Asked, answer will be posted.",
            ),
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(complete));
        const posted = (yield* Ref.get(f.dispatches)).includes("thread.system-message.record");
        assert.equal(posted, change === "unchanged");
        assert.equal(posts, 1);
        if (change === "unchanged")
          assert.equal((yield* f.service.getIdentity())?.threadId, identity.threadId);
        else
          assert.notInclude(
            JSON.stringify(yield* Ref.get(f.sends)),
            "Delayed synthetic CTO answer",
          );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("proposal review survives session rotation and exposes only current-context text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-proposal-review-" });
      const vault = `${directory}/vault`;
      yield* fs.makeDirectory(vault);
      yield* fs.writeFileString(`${vault}/sentinel`, "Never edit fixture vault");
      const f = yield* fixture(
        "ask",
        true,
        undefined,
        `${directory}/state/d4-agent/workspace`,
        true,
        { memoryEnabled: true, brainVaultPath: vault },
      );
      yield* f.service.switchContext({ context: "YB" });
      for (const text of ["YB proposal approve", "YB proposal reject"]) {
        const requested = yield* f.service.requestAction({
          type: "memory-propose",
          context: "YB",
          text,
        });
        yield* f.service.resolveAction({ actionId: requested.id, decision: "approve" });
      }
      const proposals = (yield* f.service.getState()).memoryProposals!;
      assert.equal(proposals.length, 2);
      assert.equal((yield* f.service.getState()).memoryProposalCount, 2);
      yield* f.service.newSession();
      assert.equal((yield* f.service.getState()).memoryProposals?.length, 2);
      yield* f.service.switchContext({ context: "Dimaggi" });
      const foreign = yield* f.service.getState();
      assert.deepEqual(foreign.memoryProposals, []);
      assert.deepEqual(foreign.otherContextProposalCounts, [{ context: "YB", count: 2 }]);
      assert.notInclude(JSON.stringify(foreign), "YB proposal");
      assert.equal(
        (yield* Effect.result(
          f.service.resolveMemoryProposal({ proposalId: proposals[0]!.id, approve: true }),
        ))._tag,
        "Failure",
      );
      yield* f.service.switchContext({ context: "YB" });
      yield* f.service.resolveMemoryProposal({ proposalId: proposals[0]!.id, approve: true });
      const reviewed = yield* f.service.resolveMemoryProposal({
        proposalId: proposals[1]!.id,
        approve: false,
      });
      assert.equal(reviewed.memoryProposalCount, 0);
      assert.deepEqual(reviewed.memoryProposals?.map((p) => p.status).sort(), [
        "approved",
        "rejected",
      ]);
      assert.equal(
        reviewed.memoryProposals?.find((p) => p.status === "approved")?.text,
        proposals[0]!.text,
      );
      assert.deepEqual(yield* fs.readDirectory(vault), ["sentinel"]);
      assert.equal(yield* fs.readFileString(`${vault}/sentinel`), "Never edit fixture vault");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "slow memory embeddings do not hold the agent lock and cannot return across a new session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-memory-concurrency-" });
        const vault = `${directory}/vault`;
        for (const context of ["Global", "YB"]) {
          const relative = `${context}/note.md`,
            text = `${context} synthetic search marker`;
          yield* fs.makeDirectory(`${vault}/${context}/State`, { recursive: true });
          yield* fs.writeFileString(`${vault}/${relative}`, text);
          yield* fs.writeFileString(
            `${vault}/${context}/${context === "Global" ? "" : "State/"}sources.json`,
            JSON.stringify({ files: [{ path: relative, sha256: sha256Hex(text) }] }),
          );
        }
        const started = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((request, response) => {
                  let body = "";
                  request.on("data", (chunk) => {
                    body += String(chunk);
                  });
                  request.on("end", () => {
                    started.resolve();
                    void release.promise.then(() => {
                      const input = JSON.parse(body).input;
                      response.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
                    });
                  });
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(() => {
              release.resolve();
              server.closeAllConnections();
              return new Promise<void>((resolve) => server.close(() => resolve()));
            }),
        );
        const address = server.address();
        if (!address || typeof address === "string") return yield* Effect.die("No fake address");
        const f = yield* fixture(
          "read-only",
          true,
          undefined,
          `${directory}/state/d4-agent/workspace`,
          true,
          {
            memoryEnabled: true,
            brainVaultPath: vault,
            embeddingsEnabled: true,
            embeddingBaseUrl: `http://127.0.0.1:${address.port}`,
            embeddingModel: "fixture",
          },
        );
        const first = yield* f.service.switchContext({ context: "YB" });
        const search = yield* f.service
          .memorySearch({ context: "YB", query: "synthetic" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        const second = yield* f.service.newSession();
        assert.notEqual(second.threadId, first.threadId);
        release.resolve();
        assert.equal((yield* Fiber.join(search))._tag, "Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rapid context switching retains at most four sessions and resumes the same context identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const ids = new Map<string, string>();
      for (let round = 0; round < 20; round++)
        for (const context of ["Global", "YB", "Dimaggi", "YB", "Personal", "Global"] as const) {
          const identity = yield* f.service.switchContext({ context });
          if (ids.has(context)) assert.equal(identity.threadId, ids.get(context));
          ids.set(context, identity.threadId);
          const state = yield* Ref.get(f.state);
          assert.isAtMost(state.sessions!.length, 4);
          assert.equal(
            new Set(state.sessions!.map((session) => session.context)).size,
            state.sessions!.length,
          );
        }
      assert.equal(ids.size, 4);
      assert.notInclude(yield* Ref.get(f.dispatches), "thread.stop");
    }),
);

it.effect("idle timeout closes a session with a fake clock and never closes a busy session", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      sessionIdleMinutes: 30,
    });
    const first = yield* f.service.ensureThread();
    yield* TestClock.adjust("29 minutes");
    yield* f.service.tick;
    assert.equal((yield* Ref.get(f.state)).sessions?.length, 1);
    yield* TestClock.adjust("1 minute");
    yield* f.service.tick;
    assert.equal((yield* Ref.get(f.state)).sessions?.length, 0);
    assert.equal((yield* Ref.get(f.state)).bindings.length, 0);
    assert.include(yield* Ref.get(f.dispatches), "thread.stop");
    const next = yield* f.service.ensureThread();
    assert.notEqual(next.threadId, first.threadId);
    assert.isFalse(
      ((yield* Ref.get(f.state)).transcript ?? []).some((entry) => entry.text === "New session."),
    );
    assert.equal((yield* Ref.get(f.state)).sessionChangeReason, "new-session");
    yield* Ref.update(f.shells, (all) =>
      all.map((entry) =>
        entry.id === next.threadId ? { ...entry, activeRunId: RunId.make("busy") } : entry,
      ),
    );
    yield* Ref.update(f.agentShell, (entry) =>
      entry === null ? entry : { ...entry, activeRunId: RunId.make("busy") },
    );
    yield* TestClock.adjust("31 minutes");
    yield* f.service.tick;
    assert.equal((yield* Ref.get(f.state)).sessions?.length, 1);
  }),
);

it.effect(
  "a Dimaggi thread reference switches before provider input; plain titles send normally and unmapped references switch to Global",
  () =>
    Effect.gen(function* () {
      const project = ProjectId.make("dimaggi-project");
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [project]: "Dimaggi" },
      });
      yield* Ref.update(f.shells, (all) => [
        ...all,
        {
          ...target,
          id: ThreadId.make("dimaggi-thread"),
          projectId: project,
          title: "Exact title",
        },
        { ...target, id: ThreadId.make("duplicate"), title: "Exact title" },
      ]);
      yield* f.service.ensureThread();
      yield* f.send({ text: "Read dimaggi-thread" });
      assert.equal((yield* Ref.get(f.state)).brainContext, "Dimaggi");
      assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, "Read dimaggi-thread");
      yield* f.send({ text: "Read Exact title" });
      assert.equal((yield* Ref.get(f.sends)).length, 2);
      assert.equal((yield* Ref.get(f.state)).brainContext, "Dimaggi");
      yield* f.send({ text: "Read target" });
      assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
    }),
);

const staleFixture = Effect.gen(function* () {
  const project = ProjectId.make("dimaggi-project");
  const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
    projectContexts: { [project]: "Dimaggi" },
  });
  yield* Ref.update(f.shells, (all) => [
    ...all,
    { ...target, id: ThreadId.make("dimaggi-thread"), projectId: project, title: "Work" },
  ]);
  const global = yield* f.service.ensureThread();
  return { ...f, global };
});

it.effect("a send without the context and session it was written for asks for an update", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    for (const input of [
      { text: "Unbound draft" },
      { text: "Unbound draft", expectedContext: "Global" as const },
    ]) {
      const result = yield* Effect.result(f.service.sendMessage(input));
      assert.equal(result._tag === "Failure" && result.failure.reason, "client-outdated");
    }
    assert.equal((yield* Ref.get(f.sends)).length, 0);
    assert.isFalse(
      (yield* Ref.get(f.state)).userMessages?.some((entry) => entry.text === "Unbound draft") ??
        false,
    );
  }),
);

it.effect("a send written for a context another client left is rejected as stale", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    yield* f.service.switchContext({ context: "Dimaggi" });
    const sendsBefore = (yield* Ref.get(f.sends)).length;
    const transcriptBefore = (yield* Ref.get(f.state)).transcript?.length ?? 0;
    const result = yield* Effect.result(
      f.send({
        text: "Global-only draft",
        expectedContext: "Global",
        expectedThreadId: f.global.threadId,
      }),
    );
    assert.equal(result._tag === "Failure" && result.failure.reason, "stale");
    const state = yield* Ref.get(f.state);
    assert.equal(state.brainContext, "Dimaggi");
    assert.equal((yield* Ref.get(f.sends)).length, sendsBefore);
    assert.equal(state.transcript?.length ?? 0, transcriptBefore);
    assert.isFalse(
      state.userMessages?.some((entry) => entry.text === "Global-only draft") ?? false,
    );
  }),
);

it.effect("a send written for a session another client replaced is rejected as stale", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    const fresh = yield* f.service.newSession();
    assert.notEqual(fresh.threadId, f.global.threadId);
    const stale = yield* Effect.result(
      f.send({
        text: "Written for the old session",
        expectedContext: "Global",
        expectedThreadId: f.global.threadId,
      }),
    );
    assert.equal(stale._tag === "Failure" && stale.failure.reason, "stale");
    assert.equal((yield* Ref.get(f.sends)).length, 0);
    const sent = yield* f.send({
      text: "Written for the new session",
      expectedContext: "Global",
      expectedThreadId: fresh.threadId,
    });
    assert.equal(sent.threadId, fresh.threadId);
    assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, "Written for the new session");
  }),
);

it.effect("an explicit reference still switches when the send matches the displayed context", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    yield* f.send({
      text: "Read dimaggi-thread",
      expectedContext: "Global",
      expectedThreadId: f.global.threadId,
    });
    const state = yield* Ref.get(f.state);
    assert.equal(state.brainContext, "Dimaggi");
    assert.equal((yield* Ref.get(f.sends)).at(-1)?.threadId, state.threadId);
  }),
);

it.effect("of two clients racing, a Global draft never lands in the Dimaggi session", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    const view = { expectedContext: "Global" as const, expectedThreadId: f.global.threadId };
    const [switched, draft] = yield* Effect.all(
      [
        Effect.result(f.send({ text: "Read dimaggi-thread", ...view })),
        Effect.result(f.send({ text: "Global-only draft", ...view })),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(switched._tag, "Success");
    const state = yield* Ref.get(f.state);
    assert.equal(state.brainContext, "Dimaggi");
    const draftSend = (yield* Ref.get(f.sends)).find((entry) => entry.text === "Global-only draft");
    if (draft._tag === "Success") assert.equal(draftSend?.threadId, f.global.threadId);
    else {
      assert.equal(draft.failure.reason, "stale");
      assert.isUndefined(draftSend);
    }
    assert.notEqual(draftSend?.threadId, state.threadId);
  }),
);

it.effect.each(["read-only", "ask", "act"] as const)(
  "rewrite-and-send always awaits approval and permits an edited or original send (%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture(mode);
      yield* f.service.ensureThread();
      yield* f.send({ text: "Original user command" });
      const record = yield* f.service.requestAction({
        type: "send",
        threadId: targetId,
        text: "Rewritten command",
      });
      assert.equal(record.status, "pending");
      assert.equal((yield* Ref.get(f.sends)).length, 1);
      assert.equal(
        record.action.type === "send" && record.action.originalText,
        "Original user command",
      );
      yield* f.service.resolveAction({
        actionId: record.id,
        decision: "approve",
        sendOriginal: true,
      });
      assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, "Original user command");
      const edited = yield* f.service.requestAction({
        type: "send",
        threadId: targetId,
        text: "Second draft",
      });
      yield* f.service.resolveAction({
        actionId: edited.id,
        decision: "approve",
        editedText: "Human edit",
      });
      assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, "Human edit");
    }),
);

it.effect.each(["read-only", "ask", "act"] as const)(
  "pipeline and research starts always require approval and call existing services (%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture(mode);
      yield* f.service.ensureThread();
      yield* f.settings.updateSettings({
        research: {
          upsertScenario: {
            name: "fixture-research",
            pipelinePrompt: "Use approved sources and report results.",
            promptFiles: [],
          },
        },
        dev: {
          upsertScenario: {
            name: "fixture-dev",
            pipelinePrompt: "Implement the requested task.",
            promptFiles: [],
          },
        },
      });
      for (const type of ["pipeline", "research"] as const) {
        const record = yield* f.service.requestAction({
          type,
          projectId: target.projectId,
          text: "Detailed user task",
          modelSelection,
          pipelineId: type === "pipeline" ? "dev:fixture-dev" : "research:fixture-research",
        });
        assert.equal(record.status, "pending");
        assert.isFalse(
          (yield* Ref.get(f.sends)).some((send) => send.threadId === `d4-action:${record.id}`),
        );
        yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
        assert.equal(
          (yield* Ref.get(f.sends)).at(-1)?.text,
          `${type === "pipeline" ? "!dev:fixture-dev" : "!research:fixture-research"}\n\nDetailed user task`,
        );
        assert.equal(
          (yield* Ref.get(f.state)).agentThreads?.at(-1)?.threadId,
          `d4-action:${record.id}`,
        );
      }
    }),
);

it.effect("size overflow starts a summary on tick without waiting for another user message", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.ensureThread();
    yield* Ref.update(f.state, (value) => ({
      ...value,
      sessions: value.sessions!.map((session) => ({
        ...session,
        inputTokens: 601,
        contextWindow: 1000,
      })),
    }));
    yield* f.service.tick;
    assert.include((yield* Ref.get(f.sends)).at(-1)!.text, "Summarize this session");
    assert.equal((yield* Ref.get(f.state)).rotation?.pendingText, "");
  }),
);

it.effect("the first switch after upgrade retains the legacy session for resumption", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const original = yield* f.service.ensureThread();
    yield* Ref.update(f.state, ({ sessions: _sessions, ...value }) => value);
    yield* f.service.switchContext({ context: "YB" });
    assert.equal((yield* Ref.get(f.state)).sessions?.length, 2);
    const resumed = yield* f.service.switchContext({ context: "Global" });
    assert.equal(resumed.threadId, original.threadId);
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.stop");
  }),
);

it.effect("pipeline discovery supplies the configured model and only scoped project choices", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.ensureThread();
    const available = yield* f.service.listPipelines();
    assert.deepEqual(available.modelSelection, modelSelection);
    assert.isTrue(available.pipelines.every((pipeline) => pipeline.projectId === null));
    const state = yield* Ref.get(f.state);
    assert.isFalse(available.projects.some((project) => project.projectId === state.projectId));
  }),
);

it.effect("a finished task shows its answer and Nia follows up on it once", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      sessionIdleMinutes: null,
      heartbeatMinutes: 15,
      agentThreadArchiveHours: 24,
    });
    yield* f.service.ensureThread();
    const threadId = ThreadId.make("d4-action:answered");
    const runId = RunId.make("answered");
    const answeredThread = {
      ...target,
      id: threadId,
      createdBy: "agent" as const,
      latestRunId: runId,
    };
    yield* Ref.update(f.shells, (all) => [...all, answeredThread]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      thread: { ...answeredThread, lastVisitedAt: answeredThread.lastVisitedAt ?? null },
      runs: [{ id: runId, status: "completed", completedAt: now }] as unknown as typeof value.runs,
      messages: [
        {
          id: "answer",
          role: "assistant",
          runId,
          text: "Cheapest: $499 at Costco.",
          createdAt: now,
        },
      ] as unknown as typeof value.messages,
    }));
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [
        {
          threadId,
          projectId: target.projectId,
          context: "Global" as const,
          actionId: "answered",
          reportedAt: null,
          archivedAt: null,
          undoDisabled: false,
        },
      ],
    }));
    yield* f.service.tick;
    const line = (yield* Ref.get(f.state)).transcript!.find((entry) =>
      entry.text.startsWith("Completed: Private."),
    );
    assert.equal(line?.text, "Completed: Private.\nCheapest: $499 at Costco.");
    yield* TestClock.adjust("1 hour");
    yield* f.service.tick;
    const followups = (yield* Ref.get(f.sends)).filter((input) =>
      input.text.includes("A task thread you started has finished"),
    );
    assert.equal(followups.length, 1);
    assert.include(followups[0]!.text, "Cheapest: $499 at Costco.");
    assert.deepEqual((yield* Ref.get(f.state)).taskFollowups, []);
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.sends)).filter((input) =>
        input.text.includes("A task thread you started has finished"),
      ).length,
      1,
    );
  }),
);

it.effect("reports an agent-started completion, logs the delayed archive and undoes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      sessionIdleMinutes: null,
      agentThreadArchiveHours: 24,
    });
    yield* f.service.ensureThread();
    const threadId = ThreadId.make("d4-action:completed");
    const runId = RunId.make("completed");
    const completedThread = {
      ...target,
      id: threadId,
      createdBy: "agent" as const,
      latestRunId: runId,
    };
    yield* Ref.update(f.shells, (all) => [...all, completedThread]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      thread: { ...completedThread, lastVisitedAt: completedThread.lastVisitedAt ?? null },
      runs: [{ id: runId, status: "completed", completedAt: now }] as unknown as typeof value.runs,
    }));
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [
        {
          threadId,
          projectId: target.projectId,
          context: "Global" as const,
          actionId: "completed",
          reportedAt: null,
          archivedAt: null,
          undoDisabled: false,
        },
      ],
    }));
    yield* f.service.tick;
    assert.include((yield* Ref.get(f.state)).transcript!.at(-1)!.text, "Completed: Private.");
    assert.isNotNull((yield* Ref.get(f.state)).agentThreads![0]!.reportedAt);
    yield* TestClock.adjust("23 hours");
    yield* f.service.tick;
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.archive");
    const laterRunId = RunId.make("later-completion");
    const laterCompletion = yield* DateTime.now;
    yield* Ref.update(f.shells, (all) =>
      all.map((thread) =>
        thread.id === threadId
          ? { ...thread, latestRunId: laterRunId, updatedAt: laterCompletion }
          : thread,
      ),
    );
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        { id: laterRunId, status: "completed", completedAt: laterCompletion },
      ] as unknown as typeof value.runs,
    }));
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.state)).agentThreads![0]!.reportedAt,
      DateTime.formatIso(laterCompletion),
    );
    yield* TestClock.adjust("1 hour");
    yield* f.service.tick;
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.archive");
    yield* TestClock.adjust("23 hours");
    yield* f.service.tick;
    const archived = yield* f.service.getState();
    assert.equal(archived.actionLog[0]?.type, "auto-archive");
    assert.equal(archived.actionLog[0]?.status, "executed");
    assert.isNotNull(
      (yield* Ref.get(f.shells)).find((thread) => thread.id === threadId)!.archivedAt,
    );
    yield* f.service.undoArchive({ actionId: "archive:completed" });
    assert.isNull((yield* Ref.get(f.shells)).find((thread) => thread.id === threadId)!.archivedAt);
    assert.isTrue((yield* Ref.get(f.state)).agentThreads![0]!.undoDisabled);
  }),
);

const finishedTask = (
  status: string,
  options: {
    readonly tracked?: boolean;
    readonly shell?: Partial<OrchestrationV2ThreadShell>;
  } = {},
) =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      sessionIdleMinutes: null,
    });
    yield* f.service.ensureThread();
    const threadId = ThreadId.make("d4-action:small");
    const runId = RunId.make("small-run");
    const task = {
      ...target,
      id: threadId,
      title: "Rename the label",
      createdBy: "agent" as const,
      latestRunId: runId,
      ...options.shell,
    };
    yield* Ref.update(f.shells, (all) => [...all, task]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      thread: { ...task, lastVisitedAt: task.lastVisitedAt ?? null },
      runs: [{ id: runId, status, completedAt: now }] as unknown as typeof value.runs,
    }));
    if (options.tracked !== false)
      yield* Ref.update(f.state, (value) => ({
        ...value,
        agentThreads: [
          {
            threadId,
            projectId: target.projectId,
            context: "Global" as const,
            actionId: "small",
            reportedAt: null,
            archivedAt: null,
            undoDisabled: false,
          },
        ],
      }));
    yield* f.service.tick;
    const archivedAt = (yield* Ref.get(f.shells)).find(
      (entry) => entry.id === threadId,
    )!.archivedAt;
    return { f, threadId, archivedAt };
  });

it.effect("a completed Nia task archives on success and leaves one chat line with its link", () =>
  Effect.gen(function* () {
    const { f, threadId, archivedAt } = yield* finishedTask("completed");
    assert.isNotNull(archivedAt);
    const lines = ((yield* Ref.get(f.state)).transcript ?? []).filter((line) =>
      line.links.some((link) => link.threadId === threadId),
    );
    assert.deepEqual(
      lines.map((line) => line.text),
      ["Completed and archived: Rename the label."],
    );
    assert.equal((yield* f.service.getState()).actionLog[0]?.type, "auto-archive");
  }),
);

it.effect(
  "an approved send to an auto-archived Nia task unarchives it and delivers the message",
  () =>
    Effect.gen(function* () {
      const { f, threadId, archivedAt } = yield* finishedTask("completed");
      assert.isNotNull(archivedAt);
      const action = yield* f.service.requestAction({
        type: "send",
        threadId,
        text: "Also update the docs.",
      });
      yield* f.service.resolveAction({ actionId: action.id, decision: "approve" });
      assert.isNull((yield* Ref.get(f.shells)).find((entry) => entry.id === threadId)!.archivedAt);
      assert.include(yield* Ref.get(f.dispatches), "thread.unarchive");
      assert.deepEqual(
        (yield* Ref.get(f.sends)).map((send) => [send.threadId, send.text]),
        [[threadId, "Also update the docs."]],
      );
      const record = (yield* f.service.getState()).actionLog.find(
        (entry) => entry.id === action.id,
      );
      assert.equal(record?.status, "executed");
    }),
);

it.effect("a send that still fails tells the user why", () =>
  Effect.gen(function* () {
    const { f, threadId } = yield* finishedTask("completed");
    yield* Ref.set(f.failSend, true);
    const action = yield* f.service.requestAction({ type: "send", threadId, text: "Retry." });
    yield* Effect.result(f.service.resolveAction({ actionId: action.id, decision: "approve" }));
    const record = (yield* f.service.getState()).actionLog.find((entry) => entry.id === action.id);
    assert.equal(record?.status, "failed");
    assert.equal(
      record?.failure,
      "The thread service rejected this action; open the thread to check its state.",
    );
  }),
);

it.effect.each(["failed", "interrupted", "cancelled"])("a %s Nia task is not archived", (status) =>
  Effect.gen(function* () {
    const { f, archivedAt } = yield* finishedTask(status);
    assert.isNull(archivedAt);
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.archive");
  }),
);

it.effect.each([
  ["a pending question", { pendingRuntimeRequest: { id: "question" } as never }],
  ["a user reply", { latestUserAuthoredMessageAt: now }],
  ["a linked pull request", { pullRequests: [{ url: "https://example.test/pr/1" }] as never }],
] as const)("a completed Nia task with %s is not archived", ([_label, shell]) =>
  Effect.gen(function* () {
    const { f, archivedAt } = yield* finishedTask("completed", { shell });
    assert.isNull(archivedAt);
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.archive");
  }),
);

it.effect("a completed thread Nia did not launch is not archived", () =>
  Effect.gen(function* () {
    const { f, archivedAt } = yield* finishedTask("completed", { tracked: false });
    assert.isNull(archivedAt);
    assert.notInclude(yield* Ref.get(f.dispatches), "thread.archive");
  }),
);

it.effect(
  "incidental common titles, agent-renamed titles, and duplicate titles never route or block",
  () =>
    Effect.gen(function* () {
      const otherProject = ProjectId.make("dimaggi-project");
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "YB", [otherProject]: "Dimaggi" },
      });
      yield* Ref.update(f.shells, (all) => [
        ...all,
        ...["web", "status", "web"].map((title, index) => ({
          ...target,
          id: ThreadId.make(`foreign-${index}`),
          projectId: otherProject,
          title,
          createdBy: "agent" as const,
        })),
      ]);
      const identity = yield* f.service.switchContext({ context: "YB" });
      for (const text of [
        "check the web build for YB-1234 and summarise the customer notes",
        "status of customer notes",
        "web status",
      ]) {
        yield* f.send({ text });
        assert.equal((yield* Ref.get(f.state)).brainContext, "YB");
        assert.equal((yield* Ref.get(f.sends)).at(-1)?.threadId, identity.threadId);
        assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, text);
      }
      assert.equal((yield* Ref.get(f.sends)).length, 3);
    }),
);

it.effect(
  "work-context ambiguity reveals no foreign title or id; Global may display metadata",
  () =>
    Effect.gen(function* () {
      const foreign = ProjectId.make("foreign-project");
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "YB", [foreign]: "Dimaggi" },
      });
      yield* Ref.update(f.shells, (all) => [
        ...all,
        {
          ...target,
          id: ThreadId.make("foreign-thread"),
          projectId: foreign,
          title: "Foreign secret title",
        },
        {
          ...target,
          id: ThreadId.make("foreign-thread-2"),
          projectId: foreign,
          title: "Second foreign title",
        },
      ]);
      yield* f.service.switchContext({ context: "YB" });
      yield* f.send({ text: "[[thread:target]] [[thread:foreign-thread]]" });
      const prompt = (yield* Ref.get(f.state)).transcript!.at(-1)!.text;
      assert.include(prompt, "Private (target)");
      assert.notInclude(prompt, "foreign-thread");
      assert.notInclude(prompt, "Foreign secret title");
      assert.equal((yield* Ref.get(f.sends)).length, 0);
      yield* f.send({
        text: "[[thread:foreign-thread]] [[thread:foreign-thread-2]]",
      });
      const foreignOnly = (yield* Ref.get(f.state)).transcript!.at(-1)!.text;
      assert.equal(
        foreignOnly,
        "Which thread, project, or pipeline do you mean? Mention one at a time.",
      );
      assert.equal((yield* Ref.get(f.state)).brainContext, "YB");
      assert.equal((yield* Ref.get(f.sends)).length, 0);
      yield* f.service.switchContext({ context: "Global" });
      yield* f.send({ text: "[[thread:target]] [[thread:foreign-thread]]" });
      assert.include((yield* Ref.get(f.state)).transcript!.at(-1)!.text, "Foreign secret title");
    }),
);

it.effect("archived references cannot switch context", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    yield* Ref.update(f.shells, (all) => all.map((entry) => ({ ...entry, archivedAt: now })));
    yield* f.send({ text: "[[thread:target]]" });
    assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
    assert.equal((yield* Ref.get(f.sends)).length, 1);
  }),
);

it.effect("send original is bound to the active run rather than the latest queued message", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.send({ text: "First original text exactly\n  preserved" });
    const first = (yield* Ref.get(f.sends))[0]!;
    yield* f.send({ text: "Later queued unrelated instruction" });
    const runId = RunId.make("originating-run");
    yield* Ref.update(f.agentShell, (value) => value && { ...value, activeRunId: runId });
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [{ id: runId, userMessageId: first.messageId }] as unknown as typeof value.runs,
      messages: [
        { id: first.messageId, text: first.text, createdBy: "user" },
      ] as unknown as typeof value.messages,
    }));
    const card = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Draft",
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve", sendOriginal: true });
    assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, first.text);
    assert.equal(card.action.type === "send" && card.action.originalText, first.text);
  }),
);

it.effect("a persisted heartbeat run cannot send even with a spoofed original", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.send({ text: "Prior unrelated request" });
    const runId = RunId.make("heartbeat-run");
    const messageId = MessageId.make("heartbeat-message");
    yield* Ref.update(f.agentShell, (value) => value && { ...value, activeRunId: runId });
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [{ id: runId, userMessageId: messageId }] as unknown as typeof value.runs,
      messages: [
        { id: messageId, text: "Heartbeat", createdBy: "system" },
      ] as unknown as typeof value.messages,
    }));
    const result = yield* Effect.result(
      f.service
        .requestAction({
          type: "send",
          threadId: targetId,
          text: "Heartbeat draft",
          originalText: "Spoofed original",
        })
        .pipe(Effect.provideService(Access.ToolCaller, (yield* Ref.get(f.state)).threadId!)),
    );
    assert.equal(result._tag, "Failure");
    assert.equal((yield* Ref.get(f.sends)).length, 1);
  }),
);

it.effect("explicit reference expires the idle destination before attempting resume", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "YB" },
      sessionIdleMinutes: 30,
    });
    const old = yield* f.service.switchContext({ context: "YB" });
    yield* f.service.switchContext({ context: "Global" });
    yield* TestClock.adjust("31 minutes");
    const next = yield* f.send({ text: "[[thread:target]]" });
    assert.notEqual(next.threadId, old.threadId);
    assert.equal((yield* Ref.get(f.state)).brainContext, "YB");
    assert.isTrue(
      (yield* Ref.get(f.shells)).find((entry) => entry.id === old.threadId)?.archivedAt !== null,
    );
  }),
);

it.effect("ensure closes a replaced same-context session instead of dropping its record", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const old = yield* f.service.ensureThread();
    yield* Ref.update(f.state, (state) => ({
      ...state,
      threadId: ThreadId.make("replacement-session"),
      identityReady: false,
    }));
    const next = yield* f.service.ensureThread();
    assert.notEqual(next.threadId, old.threadId);
    assert.isNotNull(
      (yield* Ref.get(f.shells)).find((entry) => entry.id === old.threadId)!.archivedAt,
    );
    assert.equal((yield* Ref.get(f.state)).sessions?.length, 1);
  }),
);

it.effect.each(["create", "send"] as const)(
  "failed task %s leaves no registered agent thread",
  (failure) =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      yield* f.service.ensureThread();
      const card = yield* f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Task",
        modelSelection,
      });
      yield* Ref.set(failure === "create" ? f.failCreate : f.failSend, true);
      assert.equal(
        (yield* Effect.result(f.service.resolveAction({ actionId: card.id, decision: "approve" })))
          ._tag,
        "Failure",
      );
      assert.deepEqual((yield* Ref.get(f.state)).agentThreads ?? [], []);
    }),
);

it.effect(
  "reference catalog is reused across polls and sends and invalidated by metadata and pipeline changes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      yield* f.service.ensureThread();
      yield* f.send({ text: "hello" });
      yield* Ref.update(f.state, (state) => ({
        ...state,
        transcript: [
          {
            id: "linked",
            role: "assistant" as const,
            text: "Private",
            context: "Global" as const,
            createdAt: "1970-01-01T00:00:00.000Z",
            links: [{ label: "Private", threadId: targetId, projectId: target.projectId }],
          },
        ],
      }));
      const before = (yield* Ref.get(f.reads)).catalogs;
      for (let index = 0; index < 5; index++) {
        yield* f.service.getState();
        yield* f.send({ text: "ordinary message" });
      }
      assert.equal((yield* Ref.get(f.reads)).catalogs, before);
      yield* Ref.update(f.shells, (all) =>
        all.map((entry) => (entry.id === targetId ? { ...entry, title: "Renamed" } : entry)),
      );
      assert.equal((yield* f.service.getState()).transcript?.[0]?.links[0]?.label, "Renamed");
      assert.equal((yield* Ref.get(f.reads)).catalogs, before + 1);
      yield* Ref.update(f.eventRevision, (value) => value + 1);
      yield* f.service.getState();
      assert.equal((yield* Ref.get(f.reads)).catalogs, before + 2);
      // Unrelated events cost one bounded check; a long gap rebuilds without scanning.
      yield* Ref.set(f.relevantEvents, false);
      const checks = (yield* Ref.get(f.reads)).eventChecks;
      yield* Ref.update(f.eventRevision, (value) => value + 1);
      yield* f.service.getState();
      assert.equal((yield* Ref.get(f.reads)).catalogs, before + 2);
      assert.equal((yield* Ref.get(f.reads)).eventChecks, checks + 1);
      yield* Ref.update(f.eventRevision, (value) => value + 6000);
      yield* f.service.getState();
      assert.equal((yield* Ref.get(f.reads)).catalogs, before + 3);
      assert.equal((yield* Ref.get(f.reads)).eventChecks, checks + 1);
      yield* Ref.set(f.relevantEvents, true);
      yield* f.settings.updateSettings({
        dev: { upsertScenario: { name: "new-pipeline", pipelinePrompt: "Task", promptFiles: [] } },
      });
      yield* f.service.resolveReference("[[pipeline:dev:new-pipeline]]");
      assert.equal((yield* Ref.get(f.reads)).catalogs, before + 4);
    }),
);

it.effect("task lifecycle uses one cached projection and prunes deleted or archived entries", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      heartbeatMinutes: null,
      sessionIdleMinutes: null,
    });
    yield* f.service.ensureThread();
    const tasks = Array.from({ length: 700 }, (_, index) => ({
      ...target,
      id: ThreadId.make(`task-${index}`),
      createdBy: "agent" as const,
    }));
    yield* Ref.update(f.shells, (all) => [...all, ...tasks]);
    yield* Ref.update(f.state, (state) => ({
      ...state,
      agentThreads: tasks.map((entry, index) => ({
        threadId: entry.id,
        projectId: entry.projectId,
        context: "Global" as const,
        actionId: `task-${index}`,
        reportedAt: null,
        archivedAt: null,
        undoDisabled: false,
      })),
    }));
    yield* f.service.tick;
    const before = yield* Ref.get(f.reads);
    yield* f.service.tick;
    const after = yield* Ref.get(f.reads);
    assert.equal(after.catalogs, before.catalogs);
    assert.isBelow(after.shells - before.shells, 10);
    assert.equal(after.snapshots, before.snapshots);
    yield* Ref.update(f.shells, (all) =>
      all.map((entry) =>
        String(entry.id).startsWith("task-") ? { ...entry, archivedAt: now } : entry,
      ),
    );
    const beforePrune = (yield* Ref.get(f.reads)).updates;
    yield* f.service.tick;
    assert.deepEqual((yield* Ref.get(f.state)).agentThreads, []);
    assert.isBelow((yield* Ref.get(f.reads)).updates - beforePrune, 5);
  }),
);

it.effect("stale pipeline approval cannot register an agent task", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    yield* f.settings.updateSettings({
      dev: { upsertScenario: { name: "checked", pipelinePrompt: "First", promptFiles: [] } },
    });
    const card = yield* f.service.requestAction({
      type: "pipeline",
      pipelineId: "dev:checked",
      projectId: target.projectId,
      modelSelection,
      text: "Task",
    });
    yield* f.settings.updateSettings({
      dev: { upsertScenario: { name: "checked", pipelinePrompt: "Changed", promptFiles: [] } },
    });
    assert.equal(
      (yield* Effect.result(f.service.resolveAction({ actionId: card.id, decision: "approve" })))
        ._tag,
      "Failure",
    );
    assert.deepEqual((yield* Ref.get(f.state)).agentThreads ?? [], []);
    assert.isFalse((yield* Ref.get(f.shells)).some((entry) => entry.id === `d4-action:${card.id}`));
  }),
);

it.effect(
  "permanent archive failures bound cleanup obligations while existing chat remains usable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.ensureThread();
      yield* Ref.set(f.failStop, true);
      for (let index = 0; index < 32; index++) yield* f.service.newSession();
      assert.equal((yield* Ref.get(f.state)).pendingRetirements?.length, 32);
      const current = yield* f.service.getIdentity();
      assert.equal((yield* Effect.result(f.service.newSession()))._tag, "Failure");
      yield* f.send({ text: "Continue in the existing session" });
      assert.equal((yield* Ref.get(f.sends)).at(-1)?.threadId, current?.threadId);
      assert.equal((yield* Ref.get(f.state)).pendingRetirements?.length, 32);
      yield* Ref.set(f.failStop, false);
      yield* TestClock.adjust("30 seconds");
      yield* f.service.tick;
      assert.deepEqual((yield* Ref.get(f.state)).pendingRetirements, []);
    }),
);

it.effect("failed provider revocation retains the existing session instead of replacing it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const identity = yield* f.service.ensureThread();
    yield* Ref.update(f.state, (value) => ({
      ...value,
      sessions: (value.sessions ?? []).map((entry) => ({
        ...entry,
        providerSessionId: "unavailable-runtime",
      })),
    }));
    assert.equal((yield* Effect.result(f.service.newSession()))._tag, "Failure");
    assert.deepEqual(yield* f.service.getIdentity(), identity);
    assert.equal((yield* Ref.get(f.state)).sessions?.[0]?.threadId, identity.threadId);
  }),
);

it.effect(
  "active task capacity rejects another start without discarding existing authorizations",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      yield* f.service.ensureThread();
      const tasks = Array.from({ length: 1000 }, (_, index) => ({
        threadId: ThreadId.make(`task-${index}`),
        projectId: target.projectId,
        context: "Global" as const,
        actionId: `task-${index}`,
        reportedAt: null,
        archivedAt: null,
        undoDisabled: false,
      }));
      yield* Ref.update(f.state, (value) => ({ ...value, agentThreads: tasks }));
      const card = yield* f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        modelSelection,
        text: "One more task",
      });
      assert.equal(
        (yield* Effect.result(f.service.resolveAction({ actionId: card.id, decision: "approve" })))
          ._tag,
        "Failure",
      );
      assert.deepEqual((yield* Ref.get(f.state)).agentThreads, tasks);
    }),
);

const settledIso = "1970-01-01T00:00:00.000Z";

it.effect("settled tasks do not count toward active task capacity", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    const tasks = Array.from({ length: 1000 }, (_, index) => ({
      threadId: ThreadId.make(`task-${index}`),
      projectId: target.projectId,
      context: "Global" as const,
      actionId: `task-${index}`,
      reportedAt: null,
      archivedAt: null,
      undoDisabled: true,
      settledAt: settledIso,
    }));
    yield* Ref.update(f.state, (value) => ({ ...value, agentThreads: tasks }));
    const card = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      modelSelection,
      text: "One more task",
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    const stored = (yield* Ref.get(f.state)).agentThreads ?? [];
    assert.equal(stored.length, 1001);
    assert.equal(stored.at(-1)?.threadId, `d4-action:${card.id}`);
  }),
);

it.effect("the task sweep reloads only tracked tasks that changed", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    const task = { ...target, id: ThreadId.make("task-tracked"), createdBy: "agent" as const };
    yield* Ref.update(f.shells, (all) => [...all, task]);
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [
        {
          threadId: task.id,
          projectId: task.projectId,
          context: "Global" as const,
          actionId: "tracked",
          reportedAt: null,
          archivedAt: null,
          undoDisabled: false,
        },
      ],
    }));
    yield* f.service.tick;
    const first = yield* Ref.get(f.reads);
    yield* Ref.set(f.changedThreads, []);
    yield* Ref.update(f.shells, (all) => [...all, { ...target, id: ThreadId.make("unrelated") }]);
    yield* f.service.tick;
    const quiet = yield* Ref.get(f.reads);
    assert.equal(quiet.catalogs, first.catalogs);
    yield* Ref.set(f.changedThreads, null);
    yield* Ref.update(f.shells, (all) =>
      all.map((entry) => (entry.id === task.id ? { ...entry, archivedAt: now } : entry)),
    );
    yield* f.service.tick;
    const changed = yield* Ref.get(f.reads);
    assert.equal(changed.catalogs, first.catalogs);
    assert.isAbove(changed.shells, quiet.shells);
    assert.deepEqual((yield* Ref.get(f.state)).agentThreads, []);
  }),
);

it.effect(
  "the first task sweep, a tail read and a heartbeat that is not due read no full snapshot",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        heartbeatMinutes: 60,
      });
      yield* f.service.ensureThread();
      const task = {
        ...target,
        id: ThreadId.make("d4-action:tracked"),
        createdBy: "agent" as const,
      };
      yield* Ref.update(f.shells, (all) => [...all, task]);
      yield* Ref.update(f.state, (value) => ({
        ...value,
        agentThreads: [
          {
            threadId: task.id,
            projectId: task.projectId,
            context: "Global" as const,
            actionId: "tracked",
            reportedAt: null,
            archivedAt: null,
            undoDisabled: false,
          },
        ],
      }));
      const before = (yield* Ref.get(f.reads)).catalogs;
      yield* f.service.tick;
      yield* f.service.tick;
      yield* f.service.readTail(targetId, 10);
      assert.equal((yield* Ref.get(f.reads)).catalogs, before);
      assert.equal((yield* Ref.get(f.state)).agentThreads?.length, 1);
      // Once the interval has passed, the heartbeat builds its digest again.
      yield* TestClock.adjust("61 minutes");
      yield* f.service.tick;
      assert.isAbove((yield* Ref.get(f.reads)).catalogs, before);
    }),
);

it.effect("tick settles a task whose run failed and reactivates it when a run starts", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    const task = {
      ...target,
      id: ThreadId.make("task-failed"),
      createdBy: "agent" as const,
      latestRunId: RunId.make("failed"),
      activeRunId: null,
    };
    yield* Ref.update(f.shells, (all) => [...all, task]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        { id: task.latestRunId, status: "failed", completedAt: now },
      ] as unknown as typeof value.runs,
    }));
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [
        {
          threadId: task.id,
          projectId: task.projectId,
          context: "Global" as const,
          actionId: "failed",
          reportedAt: null,
          archivedAt: null,
          undoDisabled: false,
        },
      ],
    }));
    yield* f.service.tick;
    assert.isString((yield* Ref.get(f.state)).agentThreads?.[0]?.settledAt);
    yield* Ref.update(f.shells, (all) =>
      all.map((entry) =>
        entry.id === task.id
          ? { ...entry, activeRunId: RunId.make("again"), updatedAt: DateTime.makeUnsafe(1000) }
          : entry,
      ),
    );
    yield* Ref.update(f.eventRevision, (value) => value + 1);
    yield* f.service.tick;
    assert.isNull((yield* Ref.get(f.state)).agentThreads?.[0]?.settledAt);
  }),
);

it.effect("the sweep keeps an archived task's scope and revokes a deleted task's scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    const archived = { ...target, id: ThreadId.make("task-archived"), archivedAt: now };
    const deleted = { ...target, id: ThreadId.make("task-deleted"), deletedAt: now };
    yield* Ref.update(f.shells, (all) => [...all, archived, deleted]);
    const entry = (threadId: ThreadId) => ({
      threadId,
      projectId: target.projectId,
      context: "Global" as const,
      actionId: threadId,
      reportedAt: null,
      archivedAt: null,
      undoDisabled: false,
    });
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [entry(archived.id), entry(deleted.id)],
      taskScopes: [
        { threadId: archived.id, projectId: target.projectId, context: "Global" as const },
        { threadId: deleted.id, projectId: target.projectId, context: "Global" as const },
      ],
    }));
    yield* f.service.tick;
    const state = yield* Ref.get(f.state);
    assert.deepEqual(state.agentThreads, []);
    assert.deepEqual(
      state.taskScopes?.map((scope) => scope.threadId),
      [archived.id],
    );
  }),
);

it("the store keeps every active task and only the newest settled ones", () => {
  const entry = (index: number, settled: boolean) => ({
    threadId: ThreadId.make(`task-${index}`),
    projectId: target.projectId,
    context: "Global" as const,
    actionId: `task-${index}`,
    reportedAt: null,
    archivedAt: null,
    undoDisabled: false,
    settledAt: settled ? settledIso : null,
  });
  const agentThreads = [
    entry(0, false),
    ...Array.from({ length: 1005 }, (_, index) => entry(index + 1, true)),
    entry(2000, false),
  ];
  const state: Store.StoredState = {
    retiringThreadId: null,
    brainContext: "Global",
    contextChangedAt: null,
    contextScopeHash: null,
    bindings: [],
    identityReady: false,
    automaticActions: [],
    threadId: null,
    projectId: null,
    actions: [],
    usage: [],
    usageCursor: "",
    heartbeatAt: 0,
    heartbeatKeys: [],
    systemEpisodes: [],
    systemClaims: [],
    agentThreads,
  };
  const bounded = Store.boundStoredState(state, 0).agentThreads!;
  assert.equal(bounded.length, 1002);
  assert.equal(bounded[0]?.threadId, "task-0");
  assert.equal(bounded[1]?.threadId, "task-6");
  assert.equal(bounded.at(-1)?.threadId, "task-2000");
});

it.effect("a failed completion projection read retries the same unchanged task", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      agentThreadArchiveHours: null,
    });
    yield* f.service.ensureThread();
    yield* f.service.tick;
    const task = {
      ...target,
      id: ThreadId.make("task-retry"),
      createdBy: "agent" as const,
      latestRunId: RunId.make("completed"),
    };
    yield* Ref.update(f.shells, (all) => [...all, task]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        { id: task.latestRunId, status: "completed", completedAt: now },
      ] as unknown as typeof value.runs,
    }));
    yield* Ref.update(f.state, (value) => ({
      ...value,
      agentThreads: [
        {
          threadId: task.id,
          projectId: task.projectId,
          context: "Global" as const,
          actionId: "retry",
          reportedAt: null,
          archivedAt: null,
          undoDisabled: false,
        },
      ],
    }));
    yield* Ref.set(f.failSnapshot, true);
    assert.equal((yield* Effect.result(f.service.tick))._tag, "Failure");
    yield* Ref.set(f.failSnapshot, false);
    yield* f.service.tick;
    assert.isNotNull((yield* Ref.get(f.state)).agentThreads?.[0]?.reportedAt);
    assert.include((yield* Ref.get(f.state)).transcript!.at(-1)!.text, "Completed: Private.");
  }),
);

it.effect("task cursors are dropped with their record, also when no task is left", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      agentThreadArchiveHours: null,
    });
    yield* f.service.ensureThread();
    yield* f.service.tick;
    const task = {
      ...target,
      id: ThreadId.make("task-evicted"),
      createdBy: "agent" as const,
      latestRunId: RunId.make("completed"),
    };
    yield* Ref.update(f.shells, (all) => [...all, task]);
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        { id: task.latestRunId, status: "completed", completedAt: now },
      ] as unknown as typeof value.runs,
    }));
    const record = {
      threadId: task.id,
      projectId: task.projectId,
      context: "Global" as const,
      actionId: "evicted",
      reportedAt: null,
      archivedAt: null,
      undoDisabled: false,
    };
    const reports = Effect.map(
      Ref.get(f.state),
      (state) => state.transcript?.filter((entry) => entry.text === "Completed: Private.").length,
    );
    yield* Ref.update(f.state, (value) => ({ ...value, agentThreads: [record] }));
    yield* f.service.tick;
    assert.equal(yield* reports, 1);
    // The store evicts the record, leaving no tracked task; its cursor must go with it.
    yield* Ref.update(f.state, (value) => ({ ...value, agentThreads: [] }));
    yield* f.service.tick;
    // A record for the same thread is evaluated afresh, not skipped by a leftover cursor.
    yield* Ref.update(f.state, (value) => ({ ...value, agentThreads: [record] }));
    yield* f.service.tick;
    assert.equal(yield* reports, 2);
  }),
);

it.effect("closing the session of a pending rotation tells the user the message was not sent", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    yield* Ref.update(f.state, (state) => ({
      ...state,
      sessions: (state.sessions ?? []).map((entry) => ({
        ...entry,
        inputTokens: 80,
        contextWindow: 100,
      })),
    }));
    const original = "Pending ask that never reached a provider";
    const attachments = [
      {
        type: "image" as const,
        id: ChatAttachmentId.make("fixture-image"),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
    ];
    yield* f.send({ text: original, attachments });
    assert.equal((yield* Ref.get(f.state)).rotation?.pendingText, original);
    yield* f.service.newSession();
    const state = yield* Ref.get(f.state);
    assert.isNull(state.rotation ?? null);
    const notice = state.transcript?.find((entry) => entry.id.startsWith("rotation-dropped:"));
    assert.equal(notice?.role, "system");
    assert.include(notice?.text, original);
    assert.deepEqual(notice?.attachments, attachments);
  }),
);

it.effect("a session without a reported window rotates on the configured fallback window", () =>
  Effect.gen(function* () {
    const fill = (f: { readonly state: Ref.Ref<Store.StoredState> }) =>
      Ref.update(f.state, (state) => ({
        ...state,
        sessions: (state.sessions ?? []).map((entry) => ({
          ...entry,
          inputTokens: 70_000,
          contextWindow: null,
        })),
      }));
    const unknown = yield* fixture("ask");
    yield* unknown.service.ensureThread();
    yield* fill(unknown);
    yield* unknown.send({ text: "No window known" });
    assert.isUndefined((yield* Ref.get(unknown.state)).rotation);

    const configured = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      contextWindowTokens: 100_000,
    });
    yield* configured.service.ensureThread();
    yield* fill(configured);
    yield* configured.send({ text: "Window configured" });
    assert.isDefined((yield* Ref.get(configured.state)).rotation);
  }),
);

it.effect("send original keeps the pending user text after a size rotation", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    const initial = yield* f.service.ensureThread();
    yield* Ref.update(f.state, (state) => ({
      ...state,
      sessions: (state.sessions ?? []).map((entry) => ({
        ...entry,
        inputTokens: 80,
        contextWindow: 100,
      })),
    }));
    const original = "Exact pending ask\n  after rotation";
    yield* f.send({ text: original });
    const rotation = (yield* Ref.get(f.state)).rotation!;
    const runId = RunId.make("summary-run");
    yield* Ref.update(f.projection, (value) => ({
      ...value,
      runs: [
        { id: runId, userMessageId: rotation.messageId, status: "completed" },
      ] as unknown as typeof value.runs,
      messages: [
        {
          id: MessageId.make("summary-result"),
          role: "assistant",
          runId,
          text: "Scoped summary",
          createdAt: now,
        },
      ] as unknown as typeof value.messages,
    }));
    yield* f.service.tick;
    const delivered = (yield* Ref.get(f.sends)).at(-1)!;
    assert.notEqual(delivered.threadId, initial.threadId);
    assert.equal(delivered.text, original);
    const card = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Rewrite",
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve", sendOriginal: true });
    assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, original);
  }),
);

it.effect("rotation preserves an explicit null task snapshot across a later default change", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    yield* Ref.update(f.state, (state) => ({
      ...state,
      sessions: (state.sessions ?? []).map((entry) => ({
        ...entry,
        inputTokens: 80,
        contextWindow: 100,
      })),
    }));
    yield* f.send({ text: "Explain without creating work", taskModelSelection: null });
    const before = (yield* Ref.get(f.state)).rotation!;
    assert.isTrue(Object.hasOwn(before, "pendingTaskModelSelection"));
    assert.isNull(before.pendingTaskModelSelection);
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        taskModelSelection: modelSelection,
      },
    });
    assert.isNull((yield* Ref.get(f.state)).rotation?.pendingTaskModelSelection);
  }),
);

it.effect.each(["create", "send"] as const)(
  "a rotated message survives a failed %s and a restart, then is delivered once",
  (failure) =>
    Effect.gen(function* () {
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        sessionIdleMinutes: 30,
      });
      const initial = yield* f.service.ensureThread();
      yield* Ref.update(f.state, (state) => ({
        ...state,
        sessions: (state.sessions ?? []).map((entry) => ({
          ...entry,
          inputTokens: 80,
          contextWindow: 100,
        })),
      }));
      const original = failure === "create" ? "" : "Pending request that must survive";
      const attachments = [
        {
          type: "image" as const,
          id: ChatAttachmentId.make("fixture-image"),
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 3,
        },
      ];
      yield* f.send({ text: original, attachments, followUpBehavior: "queue" });
      const summary = (yield* Ref.get(f.state)).rotation!;
      assert.deepEqual(summary.pendingAttachments, attachments);
      assert.equal(summary.pendingFollowUpBehavior, "queue");
      const runId = RunId.make("summary-run");
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [
          { id: runId, userMessageId: summary.messageId, status: "completed" },
        ] as unknown as typeof value.runs,
        messages: [
          {
            id: MessageId.make("summary-result"),
            role: "assistant",
            runId,
            text: "Scoped summary",
            createdAt: now,
          },
        ] as unknown as typeof value.messages,
        turnItems: [
          {
            id: "error-run-b",
            runId: "run-b",
            type: "error",
            status: "failed",
            updatedAt: "2026-10-27T16:05:00.000Z",
            failure: {
              class: "validation_error",
              message: "Pipeline research:default changed after approval. Use Resume.",
              code: null,
              retryable: false,
            },
          },
        ] as unknown as typeof value.turnItems,
      }));
      yield* Ref.set(failure === "create" ? f.failCreate : f.failSend, true);
      yield* f.service.tick;
      const pending = (yield* Ref.get(f.state)).rotation;
      assert.equal(pending?.pendingText, original);
      assert.isDefined(pending?.targetThreadId);
      assert.equal(pending?.seedSummary, "Scoped summary");
      assert.isFalse((yield* Ref.get(f.sends)).some((entry) => entry.text === original));

      // Idle cleanup must not close the sessions of an undelivered rotation.
      yield* TestClock.adjust("31 minutes");
      yield* f.service.tick.pipe(Effect.ignore);
      const idle = yield* Ref.get(f.state);
      assert.equal(idle.rotation?.pendingText, original);
      assert.equal(idle.rotation?.deliveryId, pending!.deliveryId);
      assert.isFalse(idle.transcript?.some((entry) => entry.id.startsWith("rotation-dropped:")));

      yield* Ref.set(f.failCreate, false);
      yield* Ref.set(f.failSend, false);
      const restarted = yield* f.restart;
      yield* restarted.tick;
      yield* restarted.tick;
      const state = yield* Ref.get(f.state);
      const deliveries = (yield* Ref.get(f.sends)).filter((entry) => entry.text === original);
      assert.equal(deliveries.length, 1);
      assert.deepEqual(deliveries[0]!.attachments, attachments);
      assert.equal(deliveries[0]!.mode, "queue");
      assert.equal(deliveries[0]!.threadId, pending!.targetThreadId);
      assert.notEqual(deliveries[0]!.threadId, initial.threadId);
      assert.equal(deliveries[0]!.commandId, `d4-agent:message:${pending!.deliveryId}`);
      // The delivered message keeps the id of the transcript entry the user already sees.
      assert.equal(
        state.transcript?.find((entry) => entry.role === "user" && entry.text === original)?.id,
        deliveries[0]!.messageId,
      );
      assert.isNull(state.rotation);
      assert.equal(state.threadId, pending!.targetThreadId);
      assert.equal(
        state.sessions?.find((entry) => entry.threadId === pending!.targetThreadId)?.seedSummary,
        "Scoped summary",
      );
      assert.equal(
        state.transcript?.filter((entry) => entry.text.startsWith("Session size limit reached"))
          .length,
        0,
      );
    }),
);

it("per-session caches drop every thread whose session closed", () => {
  const display = new Map([
    ["open", "cursor"],
    ["closed", "cursor"],
  ]);
  const usage = new Map([["closed", "cursor"]]);
  Agent.retainOpenSessions([display, usage], [{ threadId: "open" }]);
  assert.deepEqual([...display.keys()], ["open"]);
  assert.equal(usage.size, 0);
});

const guardedFixture = (mode: D4AgentSettings["permissionMode"] = "act") =>
  Effect.gen(function* () {
    const f = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
      toolGuardUrl: "http://127.0.0.1:9191",
    });
    const agentId = ThreadId.make("agent");
    yield* Ref.set(f.agentShell, { ...target, id: agentId, activeRunId: RunId.make("agent-run") });
    yield* Ref.update(f.state, (s) => ({
      ...s,
      threadId: agentId,
      projectId: ProjectId.make("agent-project"),
      identityReady: true,
    }));
    yield* Ref.set(f.shells, [{ ...target, runtimeMode: "full-access" }]);
    return f;
  });

it.effect(
  "a send Tool Guard allows still waits for the user, then reaches a full-access thread",
  () =>
    Effect.gen(function* () {
      const f = yield* guardedFixture();
      const record = yield* f.service.requestAction({
        type: "send",
        threadId: targetId,
        text: "Rebase on main",
      });
      assert.equal(record.status, "pending");
      assert.equal(record.guard?.decision, "allowed");
      assert.deepEqual(yield* Ref.get(f.sends), []);
      yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
      assert.equal((yield* Ref.get(f.sends)).length, 1);
      // The orchestrator refuses a full-access target under an approval-required ceiling.
      assert.deepEqual(yield* Ref.get(f.sendLimits), ["full-access"]);
      const [call] = yield* Ref.get(f.guardCalls);
      assert.equal(call?.envelope_id, record.id);
      assert.equal(call?.parameters.action_type, "send");
      assert.equal(call?.parameters.target_runtime_mode, "full-access");
      assert.equal(call?.parameters.text, "Rebase on main");
    }),
);

it.effect("Tool Guard denial refuses the action and records why", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* Ref.set(f.guardVerdict, {
      decision: "denied",
      rule: "nia-deny-dangerous-send",
      reason: "Denied by: [nia-deny-dangerous-send]",
    });
    const result = yield* Effect.result(
      f.service.requestAction({ type: "send", threadId: targetId, text: "sudo rm -rf /" }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "guard-denied");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    const [stored] = (yield* Ref.get(f.state)).actions;
    assert.equal(stored?.status, "denied");
    assert.equal(stored?.guard?.rule, "nia-deny-dangerous-send");
    assert.deepEqual((yield* Ref.get(f.state)).automaticActions, []);
  }),
);

it.effect("Tool Guard escalation or silence holds the action for the user", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    for (const decision of ["escalated", "unavailable"] as const) {
      yield* Ref.set(f.guardVerdict, { decision, rule: null, reason: null });
      const record = yield* f.service.requestAction({ type: "interrupt", threadId: targetId });
      assert.equal(record.status, "pending");
      assert.equal(record.guard?.decision, decision);
    }
    assert.deepEqual(yield* Ref.get(f.dispatches), []);
    // The second interrupt card for the same thread replaces the first one.
    const [first, second] = (yield* Ref.get(f.state)).actions;
    assert.equal(first?.status, "denied");
    assert.equal(first?.supersededBy, second?.id);
    yield* f.service.resolveAction({ actionId: second!.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.dispatches), ["interrupt"]);
  }),
);

it.effect("ask mode holds even actions Tool Guard allows", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture("ask");
    const record = yield* f.service.requestAction({ type: "interrupt", threadId: targetId });
    assert.equal(record.status, "pending");
    assert.deepEqual(yield* Ref.get(f.dispatches), []);
  }),
);

it.effect("without Tool Guard, full-access threads stay out of reach", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    yield* Ref.set(f.shells, [{ ...target, runtimeMode: "full-access" }]);
    const result = yield* Effect.result(
      f.service.requestAction({ type: "interrupt", threadId: targetId }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "action-unavailable");
    assert.deepEqual(yield* Ref.get(f.guardCalls), []);
  }),
);

it.effect("a pc command Tool Guard allows still waits for the user", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const record = yield* f.service.requestAction({ type: "pc", command: "echo hi" });
    assert.equal(record.status, "pending");
    assert.deepEqual(yield* Ref.get(f.pcCommands), []);
    const [call] = yield* Ref.get(f.guardCalls);
    assert.equal(call?.parameters.action_type, "pc");
    assert.equal(call?.parameters.text, "echo hi");
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.pcCommands), ["echo hi"]);
  }),
);

it.effect("an approved start links the thread it created", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const record = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Fix the flaky login test\nIt fails on CI only.",
      modelSelection,
    });
    assert.equal(record.status, "pending");
    assert.equal((yield* f.service.getState()).actionLog[0]?.threadId, undefined);
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    const state = yield* f.service.getState();
    assert.equal(state.actionLog[0]?.threadId, ThreadId.make(`d4-action:${record.id}`));
    const posted = state.transcript?.at(-1);
    assert.equal(posted?.text, "New thread: Fix the flaky login test");
    assert.equal(posted?.links[0]?.threadId, ThreadId.make(`d4-action:${record.id}`));
  }),
);

it.effect("a guarded start gets a short title and auto mode, judged by Tool Guard", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const record = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Task: reduce approval friction in Nia's action cards (d4research).\nDetails.",
      modelSelection,
    });
    const call = (yield* Ref.get(f.guardCalls)).at(-1);
    assert.equal(call?.parameters.target_runtime_mode, "auto");
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.creates), [
      { title: "reduce approval friction in Nia's action cards (d4research)", runtimeMode: "auto" },
    ]);
  }),
);

it.effect("an unguarded start keeps per-step approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.ensureThread();
    const record = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Task",
      modelSelection,
    });
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    assert.equal((yield* Ref.get(f.creates))[0]?.runtimeMode, "approval-required");
  }),
);

it.effect("a start for a project with a base ref launches in a fresh worktree", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectWorktreeBaseRefs: { [target.projectId]: "release" },
    });
    yield* f.service.ensureThread();
    const record = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Fix the card",
      modelSelection,
    });
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    assert.deepEqual(
      (yield* Ref.get(f.creates)).filter((entry) => entry.title !== "Nia"),
      [],
    );
    const [launch] = yield* Ref.get(f.launches);
    assert.deepInclude(launch, {
      threadId: ThreadId.make(`d4-action:${record.id}`),
      title: "Fix the card",
      runtimeMode: "approval-required",
      workspaceStrategy: { type: "worktree", baseRef: "release", startFromOrigin: false },
    });
    assert.equal(launch?.initialMessage?.text, "Fix the card");
    assert.equal(
      (yield* Ref.get(f.state)).agentThreads?.[0]?.threadId,
      ThreadId.make(`d4-action:${record.id}`),
    );
  }),
);

it.effect("Tool Guard denial keeps a pc command from running", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* Ref.set(f.guardVerdict, { decision: "denied", rule: "nia-deny", reason: null });
    const result = yield* Effect.result(
      f.service.requestAction({ type: "pc", command: "rm -rf ~" }),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual(yield* Ref.get(f.pcCommands), []);
  }),
);

it.effect("without Tool Guard a pc command waits for approval and posts its output", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    const agentId = ThreadId.make("agent");
    yield* Ref.update(f.state, (s) => ({ ...s, threadId: agentId, identityReady: true }));
    const card = yield* f.service.requestAction({ type: "pc", command: "uptime" });
    assert.equal(card.status, "pending");
    assert.deepEqual(yield* Ref.get(f.pcCommands), []);
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.pcCommands), ["uptime"]);
    assert.deepEqual(yield* Ref.get(f.systemMessages), [
      { threadId: agentId, title: "Command result", text: "Exit 0\nhi" },
    ]);
  }),
);

it.effect("read-only refuses pc, reminders and schedules", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only");
    for (const action of [
      { type: "pc", command: "uptime" },
      { type: "remind", text: "Stretch", at: "1970-01-01T00:05:00.000Z" },
    ] as const) {
      const result = yield* Effect.result(f.service.requestAction(action));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "read-only");
    }
    assert.deepEqual(yield* Ref.get(f.pcCommands), []);
  }),
);

it.effect("a reminder is posted to its context's chat when due, once", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const record = yield* f.service.requestAction({
      type: "remind",
      text: "Call the dentist",
      at: "1970-01-01T00:05:00.000Z",
    });
    assert.equal(record.status, "executed");
    assert.deepEqual(
      (yield* Ref.get(f.state)).reminders?.map((entry) => entry.text),
      ["Call the dentist"],
    );
    assert.equal((yield* f.service.tasks()).reminders.length, 1);
    yield* f.service.tick;
    assert.deepEqual(yield* Ref.get(f.systemMessages), []);
    yield* TestClock.adjust("5 minutes");
    yield* f.service.tick;
    yield* f.service.tick;
    assert.deepEqual(yield* Ref.get(f.systemMessages), [
      { threadId: ThreadId.make("agent"), title: "Reminder", text: "Call the dentist" },
    ]);
    assert.deepEqual((yield* Ref.get(f.state)).reminders, []);
  }),
);

it.effect("a past or far-future reminder is refused and a cancelled one never fires", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* TestClock.adjust("1 hour");
    for (const at of ["1970-01-01T00:00:00.000Z", "1972-01-01T00:00:00.000Z"]) {
      const result = yield* Effect.result(
        f.service.requestAction({ type: "remind", text: "Late", at }),
      );
      assert.equal(result._tag, "Failure");
    }
    const record = yield* f.service.requestAction({
      type: "remind",
      text: "Stretch",
      at: "1970-01-01T01:10:00.000Z",
    });
    yield* f.service.requestAction({ type: "cancel-reminder", reminderId: record.id });
    yield* TestClock.adjust("20 minutes");
    yield* f.service.tick;
    assert.deepEqual(yield* Ref.get(f.systemMessages), []);
  }),
);

it.effect("schedule creates an approval-required scheduled task Nia may later delete", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const record = yield* f.service.requestAction({
      type: "schedule",
      projectId: target.projectId,
      title: "Morning CI check",
      text: "Check CI and report failures",
      modelSelection,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    assert.equal(record.status, "pending");
    yield* f.service.resolveAction({ actionId: record.id, decision: "approve" });
    const [input] = yield* Ref.get(f.scheduled);
    assert.equal(input?.runtimeMode, "approval-required");
    assert.equal(input?.createdBy, "agent");
    assert.equal(input?.threadId, null);
    assert.deepEqual(
      (yield* Ref.get(f.state)).scheduledTasks?.map((entry) => entry.taskId),
      ["task-1"],
    );
    const foreign = yield* Effect.result(
      f.service.requestAction({ type: "unschedule", taskId: ScheduledTaskId.make("user-task") }),
    );
    assert.equal(foreign._tag, "Failure");
    const unschedule = yield* f.service.requestAction({
      type: "unschedule",
      taskId: ScheduledTaskId.make("task-1"),
    });
    assert.deepEqual(yield* Ref.get(f.unscheduled), []);
    yield* f.service.resolveAction({ actionId: unschedule.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.unscheduled), ["task-1"]);
    assert.deepEqual((yield* Ref.get(f.state)).scheduledTasks, []);
  }),
);

const overviewFixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-10-26T14:00:00Z"));
  const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
    heartbeatMinutes: 15,
    overviewSources: { mail: "Personal", health: "Global" },
    toolGuardUrl: "http://127.0.0.1:9191",
  });
  yield* f.service.ensureThread();
  return f;
});
const healthSnapshot = (title = "Disk needs attention"): Inbox.OverviewSnapshot => ({
  source: "health",
  context: "Global",
  items: [{ key: "disk", severity: "attention", title }],
});

it.effect("Overview posts once across repeated ticks and posts a changed revision", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
    yield* f.service.tick;
    yield* f.service.tick;
    const first = (yield* Ref.get(f.systemMessages)).filter(
      (message) => message.title === "Overview",
    );
    assert.equal(first.length, 1);
    assert.include(first[0]!.text, "Disk needs attention");
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot("Disk capacity critical")]);
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    const changed = (yield* Ref.get(f.systemMessages)).filter(
      (message) => message.title === "Overview",
    );
    assert.equal(changed.length, 2);
    assert.include(changed[1]!.text, "Disk capacity critical");
    assert.equal(new Set(yield* Ref.get(f.systemMessageIds)).size, 2);
  }),
);

it.effect(
  "Overview retries a failed dispatch with the same id and marks delivery only on success",
  () =>
    Effect.gen(function* () {
      const f = yield* overviewFixture;
      yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
      yield* Ref.set(f.failSystemMessage, true);
      yield* Effect.result(f.service.tick);
      const failed = (yield* f.service.overview()).find((item) => item.key === "disk");
      assert.isDefined(failed);
      assert.isNull(failed!.deliveredRevision);
      yield* Ref.set(f.failSystemMessage, false);
      yield* f.service.tick;
      const delivered = (yield* f.service.overview()).find((item) => item.key === "disk");
      assert.equal(delivered!.deliveredRevision, delivered!.revision);
      const ids = yield* Ref.get(f.systemMessageIds);
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
      assert.equal(
        (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
        1,
      );
    }),
);

it.effect("Overview lists only the requested source", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [
      healthSnapshot(),
      {
        source: "mail",
        context: "Global",
        items: [{ key: "mail-1", severity: "info", title: "Receipt" }],
      },
    ]);
    yield* f.service.tick;
    assert.deepEqual(
      (yield* f.service.overview({ source: "health" })).map((item) => item.key),
      ["disk"],
    );
    assert.deepEqual(yield* f.service.overview({ source: "intel" }), []);
  }),
);

it.effect(
  "Global Overview carries Personal titles once, while model input and getState omit bodies",
  () =>
    Effect.gen(function* () {
      const f = yield* overviewFixture;
      const globalThread = (yield* Ref.get(f.state)).threadId!;
      yield* Ref.set(f.inboxSnapshots, [
        {
          source: "mail",
          context: "Personal",
          items: [
            {
              key: "private-mail",
              severity: "attention",
              title: "Private medical invoice",
              body: "private body marker",
            },
          ],
        },
      ]);
      yield* Ref.update(f.state, (state) => ({
        ...state,
        transcript: [
          {
            id: "private",
            role: "system" as const,
            text: "private transcript marker",
            context: "Personal" as const,
            createdAt: "2026-10-26T14:00:00Z",
            links: [],
          },
        ],
      }));
      yield* f.service.tick;
      const messages = yield* Ref.get(f.systemMessages);
      const global = messages.filter(
        (message) => message.threadId === globalThread && message.title === "Overview",
      );
      assert.equal(global.length, 1);
      assert.include(global[0]!.text, "• Personal: Private medical invoice");
      assert.notInclude(global[0]!.text, "private body marker");
      // No second post in the Personal session, so nothing is announced twice.
      assert.isFalse(
        messages.some(
          (message) =>
            message.threadId !== globalThread && message.text.includes("Private medical invoice"),
        ),
      );
      const globalInputs = (yield* Ref.get(f.sends)).filter(
        (send) => send.threadId === globalThread,
      );
      assert.include(JSON.stringify(globalInputs), "Private medical invoice");
      assert.notInclude(JSON.stringify(globalInputs), "private body marker");
      assert.notInclude(JSON.stringify(yield* f.service.overview()), "private body marker");
      const visible = JSON.stringify(yield* f.service.getState());
      assert.notInclude(visible, "private body marker");
      assert.notInclude(visible, "private transcript marker");
      assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
    }),
);

it.effect("Global Overview shows one linked line per work thread and per scheduled task", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        projectContexts: { [target.projectId]: "Dimaggi" },
      },
    });
    yield* f.service.ensureThread();
    const globalThread = (yield* Ref.get(f.state)).threadId!;
    yield* Ref.set(f.completedThreadRuns, [
      {
        threadId: targetId,
        runId: "run-2",
        ordinal: 2,
        status: "completed",
        completedAt: "2026-10-26T13:50:00.000Z",
      },
      {
        threadId: targetId,
        runId: "run-1",
        ordinal: 1,
        status: "completed",
        completedAt: "2026-10-26T13:00:00.000Z",
      },
    ]);
    yield* Ref.set(f.scheduledRuns, [
      {
        messageId: MessageId.make("m-1"),
        taskId: ScheduledTaskId.make("nightly"),
        projectId: target.projectId,
        title: "Nightly",
        status: "succeeded",
        completedAt: "2026-10-26T12:00:00.000Z",
      },
      {
        messageId: MessageId.make("m-2"),
        taskId: ScheduledTaskId.make("nightly"),
        projectId: target.projectId,
        title: "Nightly",
        status: "failed",
        completedAt: "2026-10-26T13:00:00.000Z",
      },
    ]);
    yield* f.service.tick;
    const posts = (yield* Ref.get(f.systemMessages)).filter(
      (message) => message.title === "Overview",
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.threadId, globalThread);
    const text = posts[0]!.text;
    assert.equal(text.split("Completed: Private").length, 2);
    assert.include(text, `• Dimaggi: [[thread:${targetId}|Completed: Private]]`);
    assert.include(text, "• Dimaggi: Nightly: failed");
    assert.notInclude(text, "Nightly: succeeded");
  }),
);

it.effect("a first Overview snapshot emits only five items and persists the silent baseline", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [
      {
        ...healthSnapshot(),
        items: Array.from({ length: 8 }, (_, index) => ({
          key: `disk-${index}`,
          severity: "info" as const,
          title: `Disk ${index}`,
        })),
      },
    ]);
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    const text = (yield* Ref.get(f.systemMessages)).find(
      (message) => message.title === "Overview",
    )!.text;
    assert.equal(text.split("\n").filter((line) => line.startsWith("•")).length, 5);
    const restarted = yield* f.restart;
    yield* TestClock.adjust("15 minutes");
    yield* restarted.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    assert.isTrue(
      (yield* f.service.overview())
        .filter((item) => item.source === "health")
        .every((item) => item.deliveredRevision === item.revision),
    );
  }),
);

it.effect.each(["send", "start", "schedule"] as const)("a heartbeat rejects %s in code", (type) =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const action =
      type === "send"
        ? { type, threadId: targetId, text: "Do it" }
        : type === "start"
          ? { type, projectId: target.projectId, modelSelection, text: "Do it" }
          : {
              type,
              projectId: target.projectId,
              modelSelection,
              title: "Work",
              text: "Do it",
              schedule: { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [1] },
            };
    const result = yield* Effect.result(
      f.service
        .requestAction(action)
        .pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat")),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    assert.deepEqual(yield* Ref.get(f.scheduled), []);
  }),
);

it.effect("a heartbeat research draft waits for approval even when the guard allows", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* f.service.ensureThread();
    yield* f.settings.updateSettings({
      research: {
        upsertScenario: {
          name: "fixture-research",
          pipelinePrompt: "Use approved sources and report results.",
          promptFiles: [],
        },
      },
    });
    const record = yield* f.service
      .requestAction({
        type: "research",
        projectId: target.projectId,
        text: "YB Agent Access Mode",
        modelSelection,
        pipelineId: "research:fixture-research",
      })
      .pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat"));
    assert.equal(record.status, "pending");
    assert.isFalse(
      (yield* Ref.get(f.sends)).some((send) => send.threadId === `d4-action:${record.id}`),
    );
  }),
);

it.effect("a heartbeat may create a reminder in act mode", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    const result = yield* f.service
      .requestAction({ type: "remind", text: "Check status", at: "1970-01-01T00:10:00Z" })
      .pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat"));
    assert.equal(result.status, "executed");
    assert.equal((yield* Ref.get(f.state)).reminders?.[0]?.text, "Check status");
  }),
);

it.effect(
  "critical Overview waits through quiet hours and bypasses the interval after 07:00 PT",
  () =>
    Effect.gen(function* () {
      const f = yield* overviewFixture;
      yield* TestClock.setTime(Date.parse("2026-10-26T13:59:00Z"));
      yield* Ref.set(f.inboxSnapshots, [
        {
          ...healthSnapshot(),
          items: [{ key: "critical", severity: "critical", title: "Disk full" }],
        },
      ]);
      yield* Ref.update(f.state, (state) => ({
        ...state,
        overviewHeartbeatAt: { Global: Date.parse("2026-10-26T13:58:00Z") },
      }));
      yield* f.service.tick;
      assert.equal(
        (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
        0,
      );
      yield* TestClock.adjust("1 minute");
      yield* f.service.tick;
      assert.equal(
        (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
        1,
      );
    }),
);

it.effect("Overview ack, snooze, and reopen keep their context and control delivery", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
    yield* f.service.tick;
    yield* f.service.updateOverview({ key: "disk", op: "ack" });
    assert.equal(
      (yield* f.service.overview({ includeClosed: true })).find((item) => item.key === "disk")
        ?.status,
      "acknowledged",
    );
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    yield* f.service.updateOverview({ key: "disk", op: "reopen" });
    yield* f.service.updateOverview({ key: "disk", op: "snooze", minutes: 30 });
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    yield* f.service.updateOverview({ key: "disk", op: "reopen" });
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      2,
    );
    const item = (yield* f.service.overview({ includeClosed: true })).find(
      (item) => item.key === "disk",
    );
    assert.equal(item?.status, "open");
    assert.isNull(item?.snoozedUntil);
  }),
);

it.effect("a failed Overview judgement retries after restart without reposting the Overview", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
    yield* Ref.set(f.failSend, true);
    yield* f.service.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    assert.equal((yield* Ref.get(f.sends)).length, 0);
    yield* Ref.set(f.failSend, false);
    const restarted = yield* f.restart;
    yield* restarted.tick;
    assert.equal(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview").length,
      1,
    );
    assert.equal((yield* Ref.get(f.sends)).length, 1);
    assert.include((yield* Ref.get(f.sends))[0]!.text, "Overview is already visible");
  }),
);

it.effect("Global tools see every overview context; work-context tools only their own", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.inboxSnapshots, [
      healthSnapshot(),
      {
        source: "mail",
        context: "Personal",
        items: [{ key: "private", severity: "info", title: "Private mail title" }],
      },
    ]);
    yield* f.service.tick;
    assert.deepEqual(
      (yield* f.service.overview()).map((item) => item.key),
      ["disk", "private"],
    );
    yield* f.service.switchContext({ context: "Personal" });
    assert.deepEqual(
      (yield* f.service.overview()).map((item) => item.key),
      ["private"],
    );
    const wrong = yield* Effect.result(f.service.updateOverview({ key: "disk", op: "ack" }));
    assert.equal(wrong._tag, "Failure");
    yield* f.service.updateOverview({ key: "private", op: "ack" });
    assert.equal(
      (yield* Ref.get(f.state)).overviewItems?.find((item) => item.key === "private")?.status,
      "acknowledged",
    );
  }),
);

it.effect(
  "deterministic Overview remains visible while model judgement waits for its provider",
  () =>
    Effect.gen(function* () {
      const f = yield* overviewFixture;
      yield* Ref.set(f.catalog, []);
      yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
      yield* f.service.tick;
      assert.lengthOf(
        (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview"),
        1,
      );
      assert.lengthOf((yield* Ref.get(f.state)).overviewJudgements ?? [], 1);
      assert.isEmpty(yield* Ref.get(f.sends));
      yield* Ref.set(f.catalog, [provider]);
      yield* f.service.tick;
      assert.lengthOf(yield* Ref.get(f.sends), 1);
      assert.isEmpty((yield* Ref.get(f.state)).overviewJudgements ?? []);
    }),
);
it.effect("internal overview collection waits for the next window even when no items arrive", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* f.service.tick;
    const first = (yield* Ref.get(f.reads)).catalogs;
    yield* f.service.tick;
    assert.equal((yield* Ref.get(f.reads)).catalogs, first);
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    assert.isAbove((yield* Ref.get(f.reads)).catalogs, first);
  }),
);

it.effect.each(["queue", "steer"] as const)(
  "Nia claims uploads and delivers attachment-only %s turns",
  (followUpBehavior) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId()),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const sourcePath = resolveAttachmentPath({
        attachmentsDir: f.attachmentConfig.attachmentsDir,
        attachment,
      });
      assert.isNotNull(sourcePath);
      yield* fs.makeDirectory(f.attachmentConfig.attachmentsDir, { recursive: true });
      yield* fs.writeFile(sourcePath!, new Uint8Array([1, 2, 3]));
      const identity = yield* f.send({ text: "", attachments: [attachment], followUpBehavior });
      const delivered = (yield* Ref.get(f.sends)).at(-1)!;
      assert.equal(delivered.threadId, identity.threadId);
      assert.equal(delivered.mode, followUpBehavior);
      assert.equal(delivered.attachments.length, 1);
      assert.notEqual(delivered.attachments[0]!.id, attachment.id);
      assert.equal(
        yield* fs.exists(
          resolveAttachmentPath({
            attachmentsDir: f.attachmentConfig.attachmentsDir,
            attachment: delivered.attachments[0]!,
          })!,
        ),
        true,
      );
      const entry = (yield* Ref.get(f.state)).transcript!.find(
        (entry) => entry.id === delivered.messageId,
      );
      assert.deepEqual(entry?.attachments, delivered.attachments);
      assert.equal(entry?.text, "");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stale attachments fail before claiming uploads or dispatching", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* Effect.result(
      f.service.sendMessage({
        text: "",
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()),
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        expectedContext: "Personal",
        expectedThreadId: null,
        followUpBehavior: "steer",
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "stale");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    assert.equal((yield* Ref.get(f.state)).threadId, null);
  }),
);

it.effect("ambiguous references retain attachments by failing the send", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Ref.update(f.shells, (all) => [
      ...all,
      { ...target, id: ThreadId.make("second-target") },
    ]);
    const result = yield* Effect.result(
      f.send({
        text: "[[thread:target]] [[thread:second-target]]",
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()),
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "context");
    assert.deepEqual(yield* Ref.get(f.sends), []);
  }),
);

it.effect("a high-budget steer stays on the current session", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const identity = yield* f.service.ensureThread();
    yield* Ref.update(f.state, (value) => ({
      ...value,
      sessions: value.sessions!.map((session) => ({
        ...session,
        inputTokens: 80,
        contextWindow: 100,
      })),
    }));
    yield* f.send({ text: "Correct the current turn", followUpBehavior: "steer" });
    const sent = (yield* Ref.get(f.sends)).at(-1)!;
    assert.equal(sent.threadId, identity.threadId);
    assert.equal(sent.mode, "steer");
    assert.isUndefined((yield* Ref.get(f.state)).rotation);
  }),
);

it.effect("a rejected upload leaves no accepted transcript entry", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* Effect.result(
      f.send({
        text: "Rejected upload",
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()),
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual(yield* Ref.get(f.sends), []);
    assert.isFalse(
      (yield* Ref.get(f.state)).transcript?.some((entry) => entry.text === "Rejected upload") ??
        false,
    );
  }),
);

it.effect("explicit references claim uploads into the final context session", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    const initial = yield* f.service.ensureThread();
    const fs = yield* FileSystem.FileSystem;
    const attachment = {
      type: "image" as const,
      id: ChatAttachmentId.make(createPendingAttachmentId()),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    yield* fs.makeDirectory(f.attachmentConfig.attachmentsDir, { recursive: true });
    yield* fs.writeFile(
      resolveAttachmentPath({ attachmentsDir: f.attachmentConfig.attachmentsDir, attachment })!,
      new Uint8Array([1, 2, 3]),
    );
    const identity = yield* f.send({ text: "[[thread:target]]", attachments: [attachment] });
    const sent = (yield* Ref.get(f.sends)).at(-1)!;
    assert.notEqual(identity.threadId, initial.threadId);
    assert.equal((yield* Ref.get(f.state)).brainContext, "Dimaggi");
    assert.equal(sent.threadId, identity.threadId);
    assert.isTrue(sent.attachments[0]!.id.startsWith(`${identity.threadId}-`));
    assert.equal(
      yield* fs.exists(
        resolveAttachmentPath({
          attachmentsDir: f.attachmentConfig.attachmentsDir,
          attachment: sent.attachments[0]!,
        })!,
      ),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rotation retains claimed attachment-only input after the client deletes its upload",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = yield* f.service.ensureThread();
      const fs = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId()),
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* fs.makeDirectory(f.attachmentConfig.attachmentsDir, { recursive: true });
      const originalPath = resolveAttachmentPath({
        attachmentsDir: f.attachmentConfig.attachmentsDir,
        attachment,
      })!;
      yield* fs.writeFile(originalPath, new Uint8Array([1, 2, 3]));
      yield* Ref.update(f.state, (state) => ({
        ...state,
        sessions: state.sessions!.map((session) => ({
          ...session,
          inputTokens: 80,
          contextWindow: 100,
        })),
      }));
      yield* f.send({ text: "", attachments: [attachment], followUpBehavior: "queue" });
      const pending = (yield* Ref.get(f.state)).rotation!;
      assert.isDefined(pending.targetThreadId);
      assert.notEqual(pending.pendingAttachments![0]!.id, attachment.id);
      assert.equal((yield* Ref.get(f.sends)).length, 1);
      yield* fs.remove(originalPath);
      yield* f.service.tick;
      assert.equal((yield* Ref.get(f.state)).threadId, initial.threadId);
      assert.equal((yield* Ref.get(f.sends)).length, 1);
      const runId = RunId.make("upload-summary");
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [
          { id: runId, userMessageId: pending.messageId, status: "completed" },
        ] as unknown as typeof value.runs,
        messages: [
          {
            id: MessageId.make("upload-summary-result"),
            role: "assistant",
            runId,
            text: "Scoped summary",
            createdAt: now,
          },
        ] as unknown as typeof value.messages,
      }));
      const restarted = yield* f.restart;
      yield* restarted.tick;
      const delivered = (yield* Ref.get(f.sends)).at(-1)!;
      assert.equal(delivered.threadId, pending.targetThreadId);
      assert.equal(delivered.text, "");
      assert.equal(delivered.mode, "queue");
      assert.deepEqual(delivered.attachments, pending.pendingAttachments);
      assert.equal(
        yield* fs.exists(
          resolveAttachmentPath({
            attachmentsDir: f.attachmentConfig.attachmentsDir,
            attachment: delivered.attachments[0]!,
          })!,
        ),
        true,
      );
      assert.isNull((yield* Ref.get(f.state)).rotation);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const heartbeat = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat"));

it.effect(
  "read_tail reports the latest run's status and outcome, including on archived threads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("act");
      yield* Ref.update(f.shells, (all) =>
        all.map((thread) => (thread.id === targetId ? { ...thread, archivedAt: now } : thread)),
      );
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [
          {
            id: RunId.make("run-b"),
            ordinal: 2,
            status: "cancelled",
            requestedAt: "2026-10-27T16:00:00.000Z",
            startedAt: "2026-10-27T16:00:01.000Z",
            completedAt: "2026-10-27T16:05:00.000Z",
          },
          {
            id: RunId.make("run-a"),
            ordinal: 1,
            status: "completed",
            requestedAt: "2026-10-27T15:00:00.000Z",
            startedAt: "2026-10-27T15:00:01.000Z",
            completedAt: "2026-10-27T15:10:00.000Z",
          },
        ] as unknown as typeof value.runs,
        messages: [
          {
            id: "m1",
            runId: "run-a",
            role: "user",
            text: "Audit",
            createdAt: "2026-10-27T15:00:00.000Z",
          },
          {
            id: "m2",
            runId: "run-a",
            role: "assistant",
            text: "Done: report written.",
            createdAt: "2026-10-27T15:10:00.000Z",
          },
          {
            id: "m3",
            runId: "run-b",
            role: "user",
            text: "!research:default Deeper",
            createdAt: "2026-10-27T16:00:00.000Z",
          },
          {
            id: "m4",
            runId: "run-b",
            role: "assistant",
            text: "Step 2 of 5 running",
            createdAt: "2026-10-27T16:04:00.000Z",
          },
        ] as unknown as typeof value.messages,
        turnItems: [
          {
            id: "error-run-b",
            runId: "run-b",
            type: "error",
            status: "failed",
            updatedAt: "2026-10-27T16:05:00.000Z",
            failure: {
              class: "validation_error",
              message: "Pipeline research:default changed after approval. Use Resume.",
              code: null,
              retryable: false,
            },
          },
        ] as unknown as typeof value.turnItems,
      }));
      const tail = yield* f.service.readTail(targetId, 10);
      assert.isTrue(tail.archived);
      assert.deepEqual(tail.latestRun, {
        ordinal: 2,
        status: "cancelled",
        requestedAt: "2026-10-27T16:00:00.000Z",
        startedAt: "2026-10-27T16:00:01.000Z",
        completedAt: "2026-10-27T16:05:00.000Z",
        outcome: "Pipeline research:default changed after approval. Use Resume.",
      });
      assert.deepEqual(
        tail.messages.map((message) => [message.runOrdinal, message.createdAt]),
        [
          [1, "2026-10-27T15:00:00.000Z"],
          [1, "2026-10-27T15:10:00.000Z"],
          [2, "2026-10-27T16:00:00.000Z"],
          [2, "2026-10-27T16:04:00.000Z"],
        ],
      );
    }),
);

it.effect("read_tail refusals name the thread and the bound context", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [ProjectId.make("dimaggi")]: "Dimaggi" },
    });
    yield* f.service.switchContext({ context: "Dimaggi" });
    const result = yield* Effect.result(f.service.readTail(targetId, 10));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.reason, "context");
      assert.include(result.failure.message, `Thread ${targetId}`);
      assert.include(result.failure.message, "Dimaggi context");
    }
  }),
);

it.effect(
  "resolve finds a thread by exact id, with or without the d4-action prefix, even archived",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("act");
      const actionId = ThreadId.make("d4-action:abc-123");
      yield* Ref.set(f.shells, [
        target,
        { ...target, id: actionId, title: "Nia task", archivedAt: now },
      ]);
      for (const text of [
        "abc-123",
        "d4-action:abc-123",
        "[[thread:d4-action:abc-123|Nia task]]",
      ]) {
        const result = JSON.stringify(yield* f.service.resolveReference(text));
        assert.include(result, `"kind":"resolved"`, text);
        assert.include(result, `"threadId":"${actionId}"`, text);
      }
      assert.include(
        JSON.stringify(yield* f.service.resolveReference("no-such-id")),
        `"kind":"none"`,
      );
    }),
);

it.effect("an exact id outside the bound context's projects still resolves to nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [ProjectId.make("dimaggi")]: "Dimaggi" },
    });
    yield* Ref.set(f.shells, [target, { ...target, id: ThreadId.make("d4-action:abc-123") }]);
    yield* f.service.switchContext({ context: "Dimaggi" });
    for (const text of ["abc-123", String(targetId)])
      assert.include(JSON.stringify(yield* f.service.resolveReference(text)), `"kind":"none"`);
  }),
);

it.effect(
  "a heartbeat turn drafts resume for approval and names the control for other actions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("act");
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [
          {
            id: RunId.make("cut-run"),
            ordinal: 1,
            status: "cancelled",
            startedAt: "2026-10-27T16:00:00Z",
            userMessageId: "cut-message",
          },
        ] as unknown as typeof value.runs,
        messages: [
          { id: "cut-message", role: "user", text: "!research:default Audit the router" },
        ] as unknown as typeof value.messages,
      }));
      const card = yield* heartbeat(
        f.service.requestAction({ type: "resume", threadId: targetId }),
      );
      assert.equal(card.status, "pending");
      assert.deepEqual(yield* Ref.get(f.sends), []);
      const refused = yield* Effect.result(
        heartbeat(f.service.requestAction({ type: "settle", threadId: targetId })),
      );
      assert.equal(refused._tag, "Failure");
      if (refused._tag === "Failure") {
        assert.equal(refused.failure.reason, "action-unavailable");
        assert.include(refused.failure.message, "Background turns cannot draft settle");
        assert.include(refused.failure.message, "name the control");
      }
    }),
);

it.effect("a newer pending card for the same target supersedes the older one", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    const first = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "First draft",
    });
    const other = yield* f.service.requestAction({ type: "settle", threadId: targetId });
    const second = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Second draft",
    });
    const byId = new Map((yield* Ref.get(f.state)).actions.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(first.id)?.status, "denied");
    assert.equal(byId.get(first.id)?.supersededBy, second.id);
    assert.equal(byId.get(other.id)?.status, "pending");
    assert.equal(byId.get(second.id)?.status, "pending");
    yield* Effect.result(f.service.resolveAction({ actionId: first.id, decision: "approve" }));
    assert.deepEqual(yield* Ref.get(f.sends), []);
    yield* f.service.resolveAction({ actionId: second.id, decision: "approve" });
    assert.deepEqual(
      (yield* Ref.get(f.sends)).map((sent) => sent.text),
      ["Second draft"],
    );
  }),
);

it.effect("resolving an approved send twice delivers the message once", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* f.service.ensureThread();
    const card = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Resume the run",
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    yield* Effect.result(f.service.resolveAction({ actionId: card.id, decision: "approve" }));
    const resumeSends = (yield* Ref.get(f.sends)).filter((sent) => sent.text === "Resume the run");
    assert.deepEqual(
      resumeSends.map((sent) => sent.text),
      ["Resume the run"],
    );
  }),
);

it.effect("a request-local worker survives default changes before proposal and approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only");
    const identity = yield* f.service.ensureThread();
    yield* Ref.set(f.agentShell, {
      ...target,
      id: identity.threadId,
      projectId: identity.projectId,
      activeRunId: RunId.make("active-worker-request"),
    });
    yield* Ref.update(f.state, (state) => ({
      ...state,
      userMessages: [
        {
          threadId: identity.threadId,
          messageId: "request-with-worker",
          text: "Create the task",
          taskModelSelection: modelSelection,
        },
        {
          threadId: identity.threadId,
          messageId: "queued-later-request",
          text: "Queued after the active request",
          taskModelSelection: managerSelection,
        },
      ],
    }));
    yield* Ref.update(f.projection, (projection) => ({
      ...projection,
      runs: [
        { id: RunId.make("active-worker-request"), userMessageId: "request-with-worker" },
      ] as unknown as typeof projection.runs,
      messages: [
        { id: "request-with-worker", text: "Create the task", createdBy: "user" },
      ] as unknown as typeof projection.messages,
    }));
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        taskModelSelection: { instanceId: modelSelection.instanceId, model: "later-default" },
      },
    });
    const activeEnvironment = yield* f.service.environment();
    assert.deepEqual(activeEnvironment.d4Agent.taskModelSelection, modelSelection);
    assert.equal(activeEnvironment.d4Agent.defaultTaskModelSelection?.model, "later-default");
    const activePipelines = yield* f.service.listPipelines();
    assert.deepEqual(activePipelines.modelSelection, modelSelection);
    assert.equal(activePipelines.defaultModelSelection?.model, "later-default");
    const card = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Create the task",
      modelSelection,
    });
    assert.equal(card.action.type, "start");
    if (card.action.type === "start") assert.deepEqual(card.action.modelSelection, modelSelection);
    yield* f.settings.updateSettings({
      d4Agent: {
        ...(yield* f.settings.getSettings).d4Agent,
        taskModelSelection: null,
      },
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    const resolved = (yield* Ref.get(f.state)).actions.find((entry) => entry.id === card.id)!;
    assert.equal(resolved.status, "executed");
    assert.equal(resolved.action.type, "start");
    if (resolved.action.type === "start")
      assert.deepEqual(resolved.action.modelSelection, modelSelection);
  }),
);

it.effect("an explicit null request never adopts a later task default", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: null,
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    const identity = yield* f.send({ text: "Explain only", taskModelSelection: null });
    const accepted = (yield* Ref.get(f.sends)).at(-1)!;
    yield* Ref.set(f.agentShell, {
      ...target,
      id: identity.threadId,
      projectId: identity.projectId,
      activeRunId: RunId.make("null-worker-run"),
    });
    yield* Ref.update(f.projection, (projection) => ({
      ...projection,
      runs: [
        { id: RunId.make("null-worker-run"), userMessageId: String(accepted.messageId) },
      ] as unknown as typeof projection.runs,
      messages: [
        { id: accepted.messageId, text: "Explain only", createdBy: "user" },
      ] as unknown as typeof projection.messages,
    }));
    yield* f.settings.updateSettings({
      d4Agent: { ...(yield* f.settings.getSettings).d4Agent, taskModelSelection: modelSelection },
    });
    assert.isNull((yield* f.service.environment()).d4Agent.taskModelSelection);
    assert.isNull((yield* f.service.listPipelines()).modelSelection);
    const proposal = yield* Effect.result(
      f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Must not start",
        modelSelection,
      }),
    );
    assert.equal(proposal._tag, "Failure");
  }),
);

it.effect("a request without a worker snapshot uses the saved default worker", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: modelSelection,
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    const identity = yield* f.service.ensureThread();
    yield* Ref.set(f.agentShell, {
      ...target,
      id: identity.threadId,
      projectId: identity.projectId,
      activeRunId: RunId.make("evicted-worker-run"),
    });
    yield* Ref.update(f.projection, (projection) => ({
      ...projection,
      runs: [
        { id: RunId.make("evicted-worker-run"), userMessageId: "evicted-worker-message" },
      ] as unknown as typeof projection.runs,
      messages: [
        { id: "evicted-worker-message", text: "Create work", createdBy: "user" },
      ] as unknown as typeof projection.messages,
    }));
    assert.deepEqual((yield* f.service.environment()).d4Agent.taskModelSelection, modelSelection);
    const proposal = yield* Effect.result(
      f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Start with the default worker",
        modelSelection,
      }),
    );
    assert.equal(proposal._tag, "Success");
  }),
);

it.effect(
  "an explicit steer rebinds the active request to the new worker only after delivery",
  () =>
    Effect.gen(function* () {
      const steeredSelection = {
        instanceId: modelSelection.instanceId,
        model: "steered-worker",
      };
      const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
        modelSelection: managerSelection,
        taskModelSelection: modelSelection,
      });
      yield* Ref.set(f.catalog, [
        managerProvider,
        {
          ...provider,
          models: [
            ...provider.models,
            {
              slug: steeredSelection.model,
              name: "Steered worker",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ]);
      const identity = yield* f.service.ensureThread();
      yield* Ref.set(f.agentShell, {
        ...target,
        id: identity.threadId,
        projectId: identity.projectId,
        activeRunId: RunId.make("steered-worker-run"),
      });
      yield* Ref.update(f.state, (state) => ({
        ...state,
        userMessages: [
          {
            threadId: identity.threadId,
            messageId: "initial-worker-request",
            text: "Create the task",
            taskModelSelection: modelSelection,
          },
        ],
      }));
      yield* Ref.update(f.projection, (projection) => ({
        ...projection,
        runs: [
          { id: RunId.make("steered-worker-run"), userMessageId: "initial-worker-request" },
        ] as unknown as typeof projection.runs,
        messages: [
          { id: "initial-worker-request", text: "Create the task", createdBy: "user" },
        ] as unknown as typeof projection.messages,
      }));

      yield* f.send({
        text: "Use the steered worker",
        followUpBehavior: "steer",
        taskModelSelection: steeredSelection,
      });

      assert.deepEqual(
        (yield* f.service.environment()).d4Agent.taskModelSelection,
        steeredSelection,
      );
      assert.deepEqual((yield* f.service.listPipelines()).modelSelection, steeredSelection);
      const card = yield* f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Create the steered task",
        modelSelection: steeredSelection,
      });
      assert.equal(card.action.type, "start");
      if (card.action.type === "start")
        assert.deepEqual(card.action.modelSelection, steeredSelection);
      assert.deepEqual((yield* f.service.environment()).d4Agent.modelSelection, managerSelection);
    }),
);

const managerSelection = {
  instanceId: ProviderInstanceId.make("local-manager"),
  model: "qwen3.8-flash-next-iq3_s",
};
const managerProvider: ServerProvider = {
  ...provider,
  instanceId: managerSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Local manager",
  models: [
    {
      slug: managerSelection.model,
      name: "Qwen 3.8 Flash Next IQ3 S",
      isCustom: true,
      capabilities: null,
    },
  ],
};

it.effect("an unavailable default worker does not block the independent manager heartbeat", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: modelSelection,
      heartbeatMinutes: 15,
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    yield* f.service.ensureThread();
    yield* Ref.set(f.monitorUpdates, [
      {
        threadId: targetId,
        revision: 1,
        report: {
          schemaVersion: 1,
          runId: null,
          attemptId: null,
          classification: "needs_user",
          reason: "pending_request",
          attentionRequired: true,
          notificationEligible: true,
          reportKey: "worker-unavailable-heartbeat",
          observedAt: "1970-01-01T00:00:00Z",
          runStatus: null,
          pendingRequestId: null,
        },
      },
    ]);
    yield* Ref.set(f.catalog, [
      managerProvider,
      { ...provider, auth: { status: "unauthenticated" } },
    ]);
    yield* TestClock.adjust("16 minutes");
    yield* f.service.tick;
    assert.include((yield* Ref.get(f.sends)).at(-1)?.text ?? "", "Overview is already visible");

    const proposal = yield* Effect.result(
      f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Must remain blocked",
        modelSelection,
      }),
    );
    assert.equal(proposal._tag, "Failure");
    if (proposal._tag === "Failure") assert.equal(proposal.failure.reason, "provider-unavailable");
    assert.deepEqual(yield* Ref.get(f.createModels), [managerSelection]);
  }),
);

it.effect("generic start dispatches the exact worker while Nia keeps its distinct manager", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: modelSelection,
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    yield* f.service.ensureThread();
    const environment = yield* f.service.environment();
    assert.deepEqual(environment.d4Agent.modelSelection, managerSelection);
    assert.deepEqual(environment.d4Agent.taskModelSelection, modelSelection);
    const listed = yield* f.service.listPipelines();
    assert.deepEqual(listed.modelSelection, modelSelection);
    assert.deepEqual(listed.defaultModelSelection, modelSelection);
    const card = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Use the worker",
      modelSelection,
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.createModels), [managerSelection, modelSelection]);
    assert.deepEqual((yield* f.service.environment()).d4Agent.modelSelection, managerSelection);
  }),
);

it.effect("routine preparation creates its visible thread with the exact worker", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: modelSelection,
      projectContexts: { [target.projectId]: "Global" },
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    yield* f.service.ensureThread();
    const card = yield* f.service.requestAction({
      type: "prepare-routine",
      projectId: target.projectId,
      title: "Prepare exact worker",
      text: "Run a bounded synthetic preparation.",
      modelSelection,
      schedule: { type: "interval", everyMs: 3600000 },
    });
    yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.createModels), [managerSelection, modelSelection]);
    assert.deepEqual((yield* Ref.get(f.state)).routines?.[0]?.draft.modelSelection, modelSelection);
  }),
);

it.effect("mismatched and newly unavailable workers never fall back to the manager", () =>
  Effect.gen(function* () {
    const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
      modelSelection: managerSelection,
      taskModelSelection: modelSelection,
    });
    yield* Ref.set(f.catalog, [managerProvider, provider]);
    yield* f.service.ensureThread();
    const mismatch = yield* Effect.result(
      f.service.requestAction({
        type: "start",
        projectId: target.projectId,
        text: "Wrong worker",
        modelSelection: managerSelection,
      }),
    );
    assert.equal(mismatch._tag, "Failure");
    assert.deepEqual(yield* Ref.get(f.createModels), [managerSelection]);
    const card = yield* f.service.requestAction({
      type: "start",
      projectId: target.projectId,
      text: "Exact worker",
      modelSelection,
    });
    yield* Ref.set(f.catalog, [
      managerProvider,
      { ...provider, auth: { status: "unauthenticated" } },
    ]);
    assert.equal(
      (yield* Effect.result(f.service.resolveAction({ actionId: card.id, decision: "approve" })))
        ._tag,
      "Failure",
    );
    assert.deepEqual(yield* Ref.get(f.createModels), [managerSelection]);
    const persisted = (yield* Ref.get(f.state)).actions.find((entry) => entry.id === card.id)!;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.action.type, "start");
    if (persisted.action.type === "start")
      assert.deepEqual(persisted.action.modelSelection, modelSelection);
  }),
);

it.effect.each(["auth", "quota"] as const)(
  "an unavailable default worker (%s) refuses the send before storing the request",
  (failureKind) =>
    Effect.gen(function* () {
      const f = yield* fixture("read-only", true, undefined, "/isolated/d4-agent", true, {
        modelSelection: managerSelection,
        taskModelSelection: modelSelection,
      });
      yield* Ref.set(f.catalog, [
        managerProvider,
        {
          ...provider,
          ...(failureKind === "auth"
            ? { auth: { status: "unauthenticated" as const } }
            : {
                usageLimits: {
                  checkedAt: "1970-01-01T00:00:00.000Z",
                  windows: [
                    {
                      id: "session",
                      label: "Session",
                      kind: "session" as const,
                      usedPercent: 100,
                      resetsAt: "1970-01-01T01:00:00.000Z",
                    },
                  ],
                },
              }),
        },
      ]);
      const result = yield* Effect.result(f.send({ text: "Keep this draft" }));
      assert.equal(result._tag, "Failure");
      assert.deepEqual((yield* Ref.get(f.state)).userMessages ?? [], []);
      assert.deepEqual(yield* Ref.get(f.sends), []);
    }),
);

it.effect("distinct research proposals in one project keep separate approval cards", () =>
  Effect.gen(function* () {
    const f = yield* guardedFixture();
    yield* f.service.ensureThread();
    yield* f.settings.updateSettings({
      research: {
        upsertScenario: {
          name: "fixture-research",
          pipelinePrompt: "Use approved sources and report results.",
          promptFiles: [],
        },
      },
    });
    const first = yield* heartbeat(
      f.service.requestAction({
        type: "research",
        projectId: target.projectId,
        pipelineId: "research:fixture-research",
        text: "Research idea one",
        modelSelection,
      }),
    );
    const second = yield* heartbeat(
      f.service.requestAction({
        type: "research",
        projectId: target.projectId,
        pipelineId: "research:fixture-research",
        text: "Research idea two",
        modelSelection,
      }),
    );
    const byId = new Map((yield* Ref.get(f.state)).actions.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(first.id)?.status, "pending");
    assert.equal(byId.get(second.id)?.status, "pending");
  }),
);

it.effect("a pending card nobody answered expires after 24 hours", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    yield* f.service.ensureThread();
    const stale = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Stale draft",
    });
    const fresh = yield* f.service.requestAction({ type: "settle", threadId: targetId });
    const age = (id: string, hours: number) =>
      Ref.update(f.state, (state) => ({
        ...state,
        actions: state.actions.map((entry) =>
          entry.id === id
            ? { ...entry, createdAt: DateTime.formatIso(DateTime.makeUnsafe(-hours * 3_600_000)) }
            : entry,
        ),
      }));
    yield* age(stale.id, 25);
    yield* age(fresh.id, 23);
    yield* f.service.tick;
    const byId = new Map((yield* Ref.get(f.state)).actions.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(fresh.id)?.status, "pending");
    assert.equal(byId.get(stale.id)?.status, "denied");
    assert.equal(byId.get(stale.id)?.supersededBy, "expired");
    assert.equal(byId.get(stale.id)?.resolvedAt, "1970-01-01T00:00:00.000Z");
    yield* Effect.result(f.service.resolveAction({ actionId: stale.id, decision: "approve" }));
    assert.deepEqual(yield* Ref.get(f.sends), []);
  }),
);

it.effect("the heartbeat judges an Overview item once per day unless it got worse", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    const judgements = () =>
      Ref.get(f.sends).pipe(
        Effect.map(
          (all) =>
            all.filter((sent) => String(sent.commandId).includes("overview-heartbeat:")).length,
        ),
      );
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot()]);
    yield* f.service.tick;
    assert.equal(yield* judgements(), 1);
    yield* Ref.set(f.inboxSnapshots, [healthSnapshot("Disk still needs attention")]);
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    assert.lengthOf(
      (yield* Ref.get(f.systemMessages)).filter((message) => message.title === "Overview"),
      2,
    );
    assert.equal(yield* judgements(), 1);
    yield* Ref.set(f.inboxSnapshots, [
      { ...healthSnapshot(), items: [{ key: "disk", severity: "critical", title: "Disk full" }] },
    ]);
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    assert.equal(yield* judgements(), 2);
    yield* Ref.set(f.inboxSnapshots, [
      {
        ...healthSnapshot(),
        items: [{ key: "disk", severity: "critical", title: "Disk is full" }],
      },
    ]);
    yield* TestClock.adjust("15 minutes");
    yield* f.service.tick;
    assert.equal(yield* judgements(), 2);
    yield* Ref.set(f.inboxSnapshots, [
      {
        ...healthSnapshot(),
        items: [{ key: "disk", severity: "critical", title: "Disk full again" }],
      },
    ]);
    yield* TestClock.adjust("24 hours");
    yield* f.service.tick;
    assert.equal(yield* judgements(), 3);
  }),
);

it.effect("a cancelled run shows as interrupted work in the Overview, never as completed", () =>
  Effect.gen(function* () {
    const f = yield* overviewFixture;
    yield* Ref.set(f.completedThreadRuns, [
      {
        threadId: targetId,
        runId: "run-7",
        ordinal: 7,
        status: "cancelled",
        completedAt: "2026-10-26T13:50:00.000Z",
      },
      {
        threadId: targetId,
        runId: "run-6",
        ordinal: 6,
        status: "completed",
        completedAt: "2026-10-26T13:00:00.000Z",
      },
    ]);
    yield* f.service.tick;
    const text = (yield* Ref.get(f.systemMessages)).find(
      (message) => message.title === "Overview",
    )!.text;
    assert.include(text, "Private: run cancelled");
    assert.notInclude(text, "Completed: Private");
    const item = (yield* f.service.overview()).find(
      (entry) => entry.key === `interrupted:${targetId}`,
    );
    assert.equal(item?.severity, "attention");
    assert.include(item?.body, "run-7 (ordinal 7) ended cancelled");
  }),
);

it.effect("environment reports the host OS and package manager from os-release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-os-release-" });
      const path = `${directory}/os-release`;
      yield* fs.writeFileString(
        path,
        'NAME="CachyOS Linux"\nPRETTY_NAME="CachyOS"\nID=cachyos\nID_LIKE=arch\n',
      );
      const f = yield* fixture("act");
      const env = yield* f.service.environment().pipe(Effect.provideService(OsReleasePath, path));
      assert.equal(env.host?.os, "CachyOS");
      assert.equal(env.host?.packageManager, "pacman");
      assert.isString(env.host?.kernel);
      const missing = yield* f.service
        .environment()
        .pipe(Effect.provideService(OsReleasePath, `${directory}/absent`));
      assert.isNull(missing.host);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "read_host runs an allowlisted command without a card and refuses writes with a reason",
  () =>
    Effect.gen(function* () {
      const f = yield* guardedFixture();
      const read = yield* f.service.readHost("uptime");
      assert.deepEqual(read, {
        command: "uptime",
        exitCode: 0,
        timedOut: false,
        output: "hi\n",
      });
      assert.deepEqual(yield* Ref.get(f.pcCommands), ["uptime"]);
      assert.deepEqual((yield* Ref.get(f.state)).actions, []);
      const [call] = yield* Ref.get(f.guardCalls);
      assert.equal(call?.parameters.action_type, "read-host");
      assert.equal(call?.parameters.text, "uptime");
      const refused = yield* Effect.result(
        f.service.readHost("systemctl --user restart tg-nia-proxy.service"),
      );
      assert.equal(refused._tag, "Failure");
      if (refused._tag === "Failure") {
        assert.equal(refused.failure.reason, "action-unavailable");
        assert.include(refused.failure.message, "Not a read-only command");
        assert.include(refused.failure.message, "pc action");
      }
      const separated = yield* Effect.result(f.service.readHost("uptime; df -h /"));
      assert.equal(separated._tag, "Failure");
      if (separated._tag === "Failure")
        assert.include(separated.failure.message, "pipelines, substitutions");
      yield* Ref.set(f.guardVerdict, {
        decision: "denied",
        rule: "nia-deny-secrets-or-injection",
        reason: "Denied by: [nia-deny-secrets-or-injection]",
      });
      const denied = yield* Effect.result(f.service.readHost("uptime"));
      assert.equal(denied._tag === "Failure" && denied.failure.reason, "guard-denied");
      assert.deepEqual(yield* Ref.get(f.pcCommands), ["uptime"]);
    }),
);

it.effect("read_host is off while the system probe is disabled", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      systemProbeEnabled: false,
    });
    const result = yield* Effect.result(f.service.readHost("uptime"));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.reason, "action-unavailable");
      assert.include(result.failure.message, "system probe");
    }
    assert.deepEqual(yield* Ref.get(f.pcCommands), []);
  }),
);

it.effect("CTO refusals say why and what to do instead", () =>
  Effect.gen(function* () {
    const enabled = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      ctoEnabled: true,
      ctoBaseUrl: "http://127.0.0.1:9",
    });
    yield* enabled.service.ensureThread();
    const scoped = yield* Effect.result(
      enabled.service.ctoRead({ context: "Global", operation: "brief" }),
    );
    assert.equal(scoped._tag, "Failure");
    if (scoped._tag === "Failure") {
      assert.include(scoped.failure.message, "only in the Dimaggi context");
      assert.include(scoped.failure.message, "bound to Global");
      assert.include(scoped.failure.message, "switch-context");
    }
    const disabled = yield* fixture("act");
    yield* disabled.service.ensureThread();
    const off = yield* Effect.result(disabled.service.ctoRead({ operation: "brief" }));
    assert.equal(off._tag, "Failure");
    if (off._tag === "Failure") assert.include(off.failure.message, "disabled in Nia settings");
  }),
);

it.effect("environment reloads model, authentication and quota facts from the live catalog", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.ensureThread();
    const before = yield* f.service.environment();
    assert.equal(before.providers[0]?.quota.state, "unknown");
    yield* Ref.set(f.catalog, [
      {
        ...provider,
        enabled: false,
        auth: { status: "unauthenticated" },
        models: [{ slug: "new-custom", name: "New custom", isCustom: true, capabilities: null }],
        usageLimits: {
          checkedAt: "2026-10-28T12:00:00Z",
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 100 }],
        },
      },
    ]);
    const after = yield* f.service.environment();
    assert.equal(after.providers[0]?.available, false);
    assert.equal(after.providers[0]?.authentication, "unauthenticated");
    assert.equal(after.providers[0]?.quota.state, "reported-exhausted");
    assert.equal(after.providers[0]?.models[0]?.slug, "new-custom");
  }),
);

it.effect("environment omits private endpoint diagnostics from provider snapshots", () =>
  Effect.gen(function* () {
    const diagnostic = "https://user:fake-secret@example.invalid/private-project";
    const snapshot: ServerProvider = {
      ...provider,
      ...buildServerProvider({
        presentation: { displayName: "OpenCode" },
        enabled: true,
        checkedAt: provider.checkedAt,
        models: provider.models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Could not reach ${diagnostic}`,
        },
      }),
      unavailableReason: `Connection failed: ${diagnostic}`,
    };
    assert.include(snapshot.readiness?.remediation ?? "", diagnostic);
    const f = yield* fixture();
    yield* f.service.ensureThread();
    yield* Ref.set(f.catalog, [snapshot]);
    const result = yield* f.service.environment();
    const serialized = JSON.stringify(result);

    assert.notInclude(serialized, "fake-secret");
    assert.notInclude(serialized, "example.invalid");
    assert.notInclude(serialized, "/private-project");
    assert.notInclude(serialized, "remediation");
    assert.equal(result.providers[0]?.available, false);
    assert.equal(result.providers[0]?.readiness?.reachability, "failed");
    assert.equal(result.providers[0]?.readiness?.checkedAt, provider.checkedAt);
  }),
);

it.effect("a restarted Nia service recovers its unanswered user request on the next tick", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act");
    const identity = yield* f.service.ensureThread();
    yield* Ref.update(f.state, (state) => ({
      ...state,
      userMessages: [
        { threadId: identity.threadId, messageId: "pending-request", text: "fixture request" },
      ],
    }));
    yield* Ref.update(f.projection, (projection) => ({
      ...projection,
      thread: { ...projection.thread, id: identity.threadId },
      runs: [
        {
          id: RunId.make("cancelled-request"),
          userMessageId: MessageId.make("pending-request"),
          status: "cancelled",
          providerInstanceId: projection.thread.providerInstanceId,
          modelSelection,
          completedAt: DateTime.makeUnsafe(0),
        } as (typeof projection.runs)[number],
      ],
    }));
    yield* TestClock.adjust("1 minute");
    const restarted = yield* f.restart;
    yield* restarted.tick;
    assert.include(yield* Ref.get(f.dispatches), "message.dispatch");
  }).pipe(Effect.scoped),
);

it.effect("mapped schedule reads omit prompts and pause user-owned tasks only after approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Personal", [ProjectId.make("other")]: "YB" },
    });
    yield* f.service.switchContext({ context: "Personal" });
    const tasks = [
      {
        id: ScheduledTaskId.make("user-owned"),
        projectId: target.projectId,
        title: "Public data check",
        prompt: "PRIVATE PROMPT",
        enabled: true,
        nextRunAt: null,
        lastRunStatus: "idle",
        schedule: { type: "interval", everyMs: 3600000 },
      },
      {
        id: ScheduledTaskId.make("other-context"),
        projectId: ProjectId.make("other"),
        title: "Other",
        prompt: "SIBLING SECRET",
      },
      {
        id: ScheduledTaskId.make("unmapped"),
        projectId: ProjectId.make("unmapped"),
        title: "Unmapped",
      },
    ] as unknown as Effect.Success<
      ReturnType<ScheduledTasks.ScheduledTaskService["Service"]["list"]>
    >["tasks"];
    yield* Ref.set(f.listedSchedules, tasks);
    const result = yield* f.service.tasks();
    assert.equal(result.scheduler.available, true);
    assert.deepEqual(
      result.scheduledTasks.map((entry) => entry.taskId),
      ["user-owned"],
    );
    assert.notInclude(JSON.stringify(result), "PRIVATE PROMPT");
    assert.notInclude(JSON.stringify(result), "SIBLING SECRET");
    const action = yield* f.service.requestAction({
      type: "set-schedule-enabled",
      taskId: ScheduledTaskId.make("user-owned"),
      enabled: false,
    });
    assert.equal(action.status, "pending");
    assert.deepEqual(yield* Ref.get(f.enabledSchedules), []);
    yield* f.service.resolveAction({ actionId: action.id, decision: "approve" });
    assert.deepEqual(yield* Ref.get(f.enabledSchedules), [{ id: "user-owned", enabled: false }]);
    assert.deepEqual(yield* Ref.get(f.unscheduled), []);
    assert.equal(
      (yield* Effect.result(
        f.service.requestAction({
          type: "set-schedule-enabled",
          taskId: ScheduledTaskId.make("other-context"),
          enabled: false,
        }),
      ))._tag,
      "Failure",
    );
    const stale = yield* f.service.requestAction({
      type: "set-schedule-enabled",
      taskId: ScheduledTaskId.make("user-owned"),
      enabled: true,
    });
    yield* Ref.set(f.listedSchedules, []);
    assert.equal(
      (yield* Effect.result(f.service.resolveAction({ actionId: stale.id, decision: "approve" })))
        ._tag,
      "Failure",
    );
    assert.lengthOf(yield* Ref.get(f.enabledSchedules), 1);
  }),
);

it.effect(
  "routine preparation persists a visible setup thread and activation requires reviewed completed readiness",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("act", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "Personal" },
        projectWorktreeBaseRefs: { [target.projectId]: "main" },
      });
      const preparation = {
        type: "prepare-routine" as const,
        projectId: target.projectId,
        title: "Watch public releases",
        text: "Collect new releases and save a local report.",
        modelSelection,
        schedule: { type: "interval" as const, everyMs: 3600000 },
      };
      assert.equal(
        (yield* Effect.result(
          f.service
            .requestAction(preparation)
            .pipe(Effect.provideService(Access.DispatchOrigin, "internal-heartbeat")),
        ))._tag,
        "Failure",
      );
      const requested = yield* f.service.requestAction(preparation);
      assert.equal(requested.status, "pending");
      assert.equal((yield* f.service.requestAction(preparation)).id, requested.id);
      assert.deepEqual(yield* Ref.get(f.creates), []);
      yield* f.service.resolveAction({ actionId: requested.id, decision: "approve" });
      const routine = (yield* Ref.get(f.state)).routines![0]!;
      assert.equal(routine.status, "preparing");
      assert.equal(routine.taskId, null);
      assert.equal(routine.threadId, `d4-action:${requested.id}`);
      assert.equal((yield* f.service.getState()).routines?.[0]?.id, routine.id);
      assert.deepEqual(yield* Ref.get(f.scheduled), []);
      assert.include((yield* Ref.get(f.sends)).at(-1)!.text, "Do not create or enable schedules");
      assert.include((yield* Ref.get(f.sends)).at(-1)!.text, "no recursive delegation");
      assert.isFalse(
        (yield* Ref.get(f.state)).agentThreads?.some(
          (entry) => entry.threadId === routine.threadId,
        ) ?? false,
      );
      assert.isTrue(
        (yield* Ref.get(f.state)).taskScopes?.some((entry) => entry.threadId === routine.threadId),
      );
      assert.equal(
        (yield* Effect.result(
          f.service.resolveAction({ actionId: requested.id, decision: "approve" }),
        ))._tag,
        "Failure",
      );
      assert.lengthOf(yield* Ref.get(f.creates), 1);
      assert.deepEqual(yield* Ref.get(f.launches), []);
      const activate = {
        type: "activate-routine" as const,
        routineId: routine.id,
        readiness: {
          summary: "Trial saved a report",
          checks: [
            {
              label: "Sources, tools and local output trial",
              passed: true,
              evidence: "One synthetic public release saved to a local report",
            },
          ],
          limitations: ["No external notification configured"],
        },
      };
      assert.equal((yield* Effect.result(f.service.requestAction(activate)))._tag, "Failure");
      const completed = {
        ...target,
        id: routine.threadId,
        latestRunId: RunId.make("setup-completed"),
      };
      yield* Ref.set(f.agentShell, completed);
      yield* Ref.update(f.shells, (all) =>
        all.map((entry) => (entry.id === routine.threadId ? completed : entry)),
      );
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [{ id: completed.latestRunId, status: "completed" }] as unknown as typeof value.runs,
      }));
      assert.equal(
        (yield* Effect.result(
          f.service.requestAction({
            ...activate,
            readiness: {
              ...activate.readiness,
              checks: [{ ...activate.readiness.checks[0]!, passed: false }],
            },
          }),
        ))._tag,
        "Failure",
      );
      let approved = yield* f.service.requestAction(activate);
      assert.equal(approved.status, "pending");
      assert.equal((yield* Ref.get(f.state)).routines?.[0]?.status, "ready");
      assert.deepEqual(yield* Ref.get(f.scheduled), []);
      const newer = { ...completed, latestRunId: RunId.make("newer-setup-completed") };
      yield* Ref.set(f.agentShell, newer);
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [
          ...value.runs,
          { id: newer.latestRunId, status: "completed" },
        ] as unknown as typeof value.runs,
      }));
      assert.equal(
        (yield* Effect.result(
          f.service.resolveAction({ actionId: approved.id, decision: "approve" }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(yield* Ref.get(f.scheduled), []);
      approved = yield* f.service.requestAction(activate);
      const restarted = yield* f.restart;
      yield* restarted.resolveAction({ actionId: approved.id, decision: "approve" });
      assert.lengthOf(yield* Ref.get(f.scheduled), 1);
      assert.equal((yield* Ref.get(f.scheduled))[0]!.commandId, `d4-agent:routine:${routine.id}`);
      assert.equal((yield* Ref.get(f.scheduled))[0]!.prompt, preparation.text);
      assert.equal((yield* Ref.get(f.state)).routines?.[0]?.status, "activated");
      assert.equal((yield* Effect.result(restarted.requestAction(activate)))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(
          restarted.resolveAction({ actionId: approved.id, decision: "approve" }),
        ))._tag,
        "Failure",
      );
      assert.lengthOf(yield* Ref.get(f.scheduled), 1);
    }),
);

it.effect(
  "failed routine preparation retains an inspectable recoverable thread without scheduling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "Personal" },
      });
      const preparation = yield* f.service.requestAction({
        type: "prepare-routine",
        projectId: target.projectId,
        title: "Local watch",
        text: "Prepare local storage",
        modelSelection,
        schedule: { type: "interval", everyMs: 3600000 },
      });
      yield* Ref.set(f.failSend, true);
      assert.equal(
        (yield* Effect.result(
          f.service.resolveAction({ actionId: preparation.id, decision: "approve" }),
        ))._tag,
        "Failure",
      );
      const stored = yield* Ref.get(f.state);
      assert.equal(stored.routines?.[0]?.status, "failed");
      assert.isString(stored.routines?.[0]?.failure);
      assert.equal(stored.taskScopes?.[0]?.threadId, stored.routines?.[0]?.threadId);
      assert.deepEqual(yield* Ref.get(f.scheduled), []);
    }),
);

it.effect(
  "host routine metadata respects the bound context and cannot become an app mutation target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      const routine = {
        id: "host-only",
        title: "Local check",
        context: "Personal" as const,
        source: "cron" as const,
        schedule: "daily",
        timeZone: "UTC",
        enabled: null,
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: "unknown",
        observedAt: "2026-10-28T10:00:00Z",
        capability: "read-only" as const,
      };
      yield* Ref.set(f.hostSnapshot, {
        status: "available",
        routines: [routine, { ...routine, id: "sibling-host", context: "YB" }],
      });
      assert.lengthOf((yield* f.service.tasks()).hostRoutines.routines, 2);
      yield* f.service.switchContext({ context: "Personal" });
      assert.deepEqual(
        (yield* f.service.tasks()).hostRoutines.routines.map((entry) => entry.id),
        ["host-only"],
      );
      assert.deepEqual(
        (yield* f.service.getState()).hostRoutines?.routines.map((entry) => entry.id),
        ["host-only"],
      );
      assert.equal(
        (yield* Effect.result(
          f.service.requestAction({
            type: "set-schedule-enabled",
            taskId: ScheduledTaskId.make("host-only"),
            enabled: false,
          }),
        ))._tag,
        "Failure",
      );
      yield* Ref.set(f.hostSnapshot, { status: "unavailable", routines: [] });
      assert.equal((yield* f.service.tasks()).hostRoutines.status, "unavailable");
      assert.deepEqual(yield* Ref.get(f.enabledSchedules), []);
    }),
);

it.effect(
  "routine preparation binds bounded research delegation to the approved pipeline fingerprint",
  () =>
    Effect.gen(function* () {
      const pipelineId = "research:routine-setup";
      const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
        projectContexts: { [target.projectId]: "Personal" },
        pipelineProjects: { [pipelineId]: target.projectId },
      });
      const scenario = {
        name: "routine-setup",
        pipelinePrompt:
          "Use two bounded coding agents to check sources and local storage. Keep results visible.",
        promptFiles: [],
      };
      yield* f.settings.updateSettings({ research: { upsertScenario: scenario } });
      const preparation = {
        type: "prepare-routine" as const,
        projectId: target.projectId,
        title: "Routine with research",
        text: "Check public releases with local output",
        pipelineId,
        modelSelection,
        schedule: { type: "interval" as const, everyMs: 3600000 },
      };
      const stale = yield* f.service.requestAction(preparation);
      yield* f.settings.updateSettings({
        research: { upsertScenario: { ...scenario, pipelinePrompt: "Changed instructions" } },
      });
      assert.equal(
        (yield* Effect.result(f.service.resolveAction({ actionId: stale.id, decision: "approve" })))
          ._tag,
        "Failure",
      );
      assert.deepEqual(yield* Ref.get(f.creates), []);
      const card = yield* f.service.requestAction(preparation);
      yield* f.service.resolveAction({ actionId: card.id, decision: "approve" });
      const stored = yield* Ref.get(f.state);
      const threadId = stored.routines![0]!.threadId;
      const config = yield* f.settings.getSettings;
      assert.equal(stored.taskScopes?.[0]?.pipelineId, pipelineId);
      assert.isString(stored.taskScopes?.[0]?.pipelineHash);
      assert.isTrue(
        (yield* Ref.get(f.sends)).at(-1)!.text.startsWith("!research:routine-setup\n\n"),
      );
      assert.equal(
        evaluateTaskScope(stored, threadId, config.d4Agent, pipelineId, config).status,
        "ok",
      );
      assert.equal(
        evaluateTaskScope(stored, threadId, config.d4Agent, "research:unapproved", config).status,
        "scope-changed",
      );
      assert.isTrue(
        isAllowedTaskMcpRequest(
          { method: "tools/call", params: { name: "research_delegate" } },
          threadId,
        ),
      );
      for (const name of ["delegate_task", "scheduled_task_upsert", "d4_agent_action"]) {
        assert.isFalse(
          isAllowedTaskMcpRequest({ method: "tools/call", params: { name } }, threadId),
        );
      }
      const completed = {
        ...target,
        id: threadId,
        latestRunId: RunId.make("research-setup-completed"),
      };
      yield* Ref.set(f.agentShell, completed);
      yield* Ref.update(f.projection, (value) => ({
        ...value,
        runs: [{ id: completed.latestRunId, status: "completed" }] as unknown as typeof value.runs,
      }));
      const activation = yield* f.service.requestAction({
        type: "activate-routine",
        routineId: card.id,
        readiness: {
          summary: "Source and storage trial completed",
          checks: [{ label: "Trial", passed: true, evidence: "Synthetic local result verified" }],
          limitations: [],
        },
      });
      yield* f.service.resolveAction({ actionId: activation.id, decision: "approve" });
      assert.equal(
        (yield* Ref.get(f.scheduled))[0]!.prompt,
        "!research:routine-setup\n\nCheck public releases with local output",
      );
      yield* f.settings.updateSettings({
        research: { upsertScenario: { ...scenario, pipelinePrompt: "Changed again" } },
      });
      const changed = yield* f.settings.getSettings;
      assert.equal(
        evaluateTaskScope(stored, threadId, changed.d4Agent, pipelineId, changed).status,
        "pipeline-changed",
      );
    }),
);
