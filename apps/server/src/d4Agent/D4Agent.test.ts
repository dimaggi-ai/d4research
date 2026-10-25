import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Config from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_D4_AGENT_SETTINGS,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type AgentMonitorUpdate,
  type D4AgentSettings,
  type D4AgentSystemCheck,
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
import * as Store from "./D4AgentStore.ts";
import { contextScopeHash } from "./brainScope.ts";
import * as Access from "./D4AgentAccess.ts";
import { sha256Hex } from "@d4research/shared/hash";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fake HTTP server records exactly which CTO endpoints the service requests.
import * as NodeHttp from "node:http";
import * as Probe from "./SystemProbe.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
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
) =>
  Effect.gen(function* () {
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
    const checks = yield* Ref.make<ReadonlyArray<D4AgentSystemCheck>>([
      {
        id: "root-disk",
        status: "ok",
        reportKey: "root-disk:ok",
        value: 50,
        notificationEligible: false,
      },
    ]);
    const monitorUpdates = yield* Ref.make<ReadonlyArray<AgentMonitorUpdate>>([]);
    const agentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(null);
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([target]);
    const sends = yield* Ref.make<
      ReadonlyArray<Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0]>
    >([]);
    const failStop = yield* Ref.make(false);
    const failCreate = yield* Ref.make(false);
    const failSend = yield* Ref.make(false);
    const failSnapshot = yield* Ref.make(false);
    const eventRevision = yield* Ref.make(0);
    const request = yield* Ref.make<OrchestrationV2RuntimeRequest | undefined>(undefined);
    const dispatches = yield* Ref.make<ReadonlyArray<string>>([]);
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
    let previousShells: ReadonlyArray<OrchestrationV2ThreadShell> | undefined;
    let revision = 0;
    const stateChanges = yield* PubSub.unbounded<Store.StoredState>();
    const settingsLayer = Settings.layerTest({
      d4Agent: {
        ...DEFAULT_D4_AGENT_SETTINGS,
        enabled: true,
        modelSelection,
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
          Layer.succeed(Store.D4AgentStore, {
            workspace,
            get: Ref.get(state),
            update: (f) =>
              Ref.update(reads, (r) => ({ ...r, updates: r.updates + 1 })).pipe(
                Effect.andThen(Ref.updateAndGet(state, f)),
                Effect.tap((value) => PubSub.publish(stateChanges, value)),
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
            hasApplicationEvents: () =>
              Ref.update(reads, (r) => ({ ...r, eventChecks: r.eventChecks + 1 })).pipe(
                Effect.andThen(Ref.get(relevantEvents)),
              ),
          }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Ref.get(catalog),
          }),
          Layer.mock(Threads.ThreadManagementService)({
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
                yield* Ref.update(sends, (all) => [...all, input]);
                return {} as never;
              }),
            dispatch: (cmd) =>
              Effect.gen(function* () {
                if (cmd.type === "thread.stop" && (yield* Ref.get(failStop)))
                  return yield* Effect.fail({ reason: "fixture stop failure" } as never);
                yield* Ref.update(dispatches, (value) => [...value, cmd.type]);
                if (cmd.type === "thread.create") {
                  if (yield* Ref.get(failCreate))
                    return yield* Effect.fail({ reason: "fixture creation failure" } as never);
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
            interruptThread: () =>
              Ref.update(dispatches, (value) => [...value, "interrupt"]).pipe(
                Effect.as({ type: "no_active_run" as const }),
              ),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({
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
        ),
      ),
    );
    const scope = yield* Scope.Scope;
    const service = Context.get(yield* Layer.buildWithScope(layer, scope), Agent.D4Agent);
    // A fresh service instance over the same persisted state and threads, as after a server restart.
    const restart = Layer.buildWithScope(layer, scope).pipe(
      Effect.map((built) => Context.get(built, Agent.D4Agent)),
    );
    return {
      service,
      restart,
      state,
      stateChanges,
      settings,
      checks,
      request,
      dispatches,
      projection,
      catalog,
      reads,
      agentShell,
      shells,
      sends,
      failStop,
      failCreate,
      failSend,
      failSnapshot,
      eventRevision,
      relevantEvents,
      monitorUpdates,
    };
  });

it.effect(
  "new session retries retirement, releases the old session and rejects stale callers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("ask");
      const first = yield* f.service.ensureThread();
      yield* f.service.sendMessage({ text: "old context secret" });
      const approval = yield* f.service.requestAction({ type: "interrupt", threadId: targetId });
      yield* Ref.set(f.failStop, true);
      const replacement = yield* f.service.newSession();
      assert.notEqual(replacement.threadId, first.threadId);
      assert.equal((yield* Ref.get(f.state)).pendingRetirements?.[0]?.threadId, first.threadId);
      assert.equal((yield* f.service.getIdentity())?.projectId, first.projectId);
      yield* f.service.sendMessage({ text: "Retirement must not block this message" });
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
      yield* f.service.sendMessage({ text: "new context question" });
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

const switchRequest = "Add local DeepSeek to the CTO d4 provider list";
const switchFixture = (mode: "read-only" | "ask" | "act") =>
  Effect.gen(function* () {
    const f = yield* fixture(mode, true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    const global = yield* f.service.sendMessage({ text: switchRequest });
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
    yield* f.service.sendMessage({ text: "Older unrelated Global request" });
    yield* f.service.sendMessage({ text: "Another earlier request" });
    const current = yield* f.service.sendMessage({ text: switchRequest });
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
    yield* f.service.sendMessage({ text: switchRequest });
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
    assert.deepEqual((yield* Ref.get(f.state)).heartbeatKeys, [reportKey]);
    const heartbeat = (yield* Ref.get(f.sends)).at(-1)?.text ?? "";
    assert.include(heartbeat, "Heartbeat:");
    assert.include(heartbeat, "pending_request");
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
            instanceId: "codex",
            driver: "codex",
            available: true,
            canRunD4Agent: true,
            models: [{ slug: "chosen", name: "Chosen" }],
          },
          {
            instanceId: "deepseek",
            driver: "deepseek",
            available: true,
            canRunD4Agent: false,
            models: [{ slug: "deepseek-local", name: "DeepSeek local" }],
          },
        ],
      );
      assert.deepEqual(global.d4Agent, {
        modelSelection,
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
      const { service, state, agentShell, dispatches } = yield* fixture("act");
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
        Array.from({ length: 5 }, () =>
          Effect.result(service.requestAction({ type: "interrupt", threadId: targetId })),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((r) => r._tag === "Success").length, 1);
      assert.equal((yield* Ref.get(dispatches)).length, 1);
      assert.equal((yield* Ref.get(state)).automaticActions.length, 1);
      const restarted = yield* fixture("act");
      yield* Ref.set(restarted.state, yield* Ref.get(state));
      yield* Ref.set(restarted.agentShell, yield* Ref.get(agentShell));
      assert.equal(
        (yield* Effect.result(
          restarted.service.requestAction({ type: "interrupt", threadId: targetId }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(yield* Ref.get(restarted.dispatches), []);
      yield* Ref.update(agentShell, (s) =>
        s === null ? null : { ...s, activeRunId: RunId.make("another-run") },
      );
      assert.equal(
        (yield* Effect.result(service.requestAction({ type: "interrupt", threadId: targetId })))
          ._tag,
        "Failure",
      );
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction({ type: "interrupt", threadId: targetId });
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction({ type: "interrupt", threadId: targetId });
      yield* TestClock.adjust("10 minutes");
      yield* service.requestAction({ type: "interrupt", threadId: targetId });
      yield* TestClock.adjust("10 minutes");
      assert.equal(
        (yield* Effect.result(service.requestAction({ type: "interrupt", threadId: targetId })))
          ._tag,
        "Failure",
      );
      assert.equal((yield* Ref.get(dispatches)).length, 4);
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

it.effect("Global reads mapped thread content but its memory and actions stay Global-only", () =>
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
        f.service.requestAction({ type: "send", threadId: dimaggiThread, text: "Go" }),
      ])
        assert.equal((yield* Effect.result(denied))._tag, "Failure");
      assert.deepEqual((yield* Ref.get(f.state)).actions, []);
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
    assert.equal((yield* Ref.get(f.state)).transcript?.at(-1)?.text, "New session.");
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
      yield* f.service.sendMessage({ text: "Read dimaggi-thread" });
      assert.equal((yield* Ref.get(f.state)).brainContext, "Dimaggi");
      assert.equal((yield* Ref.get(f.sends)).at(-1)?.text, "Read dimaggi-thread");
      yield* f.service.sendMessage({ text: "Read Exact title" });
      assert.equal((yield* Ref.get(f.sends)).length, 2);
      assert.equal((yield* Ref.get(f.state)).brainContext, "Dimaggi");
      yield* f.service.sendMessage({ text: "Read target" });
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

it.effect("a send written for a context another client left is rejected as stale", () =>
  Effect.gen(function* () {
    const f = yield* staleFixture;
    yield* f.service.switchContext({ context: "Dimaggi" });
    const sendsBefore = (yield* Ref.get(f.sends)).length;
    const transcriptBefore = (yield* Ref.get(f.state)).transcript?.length ?? 0;
    const result = yield* Effect.result(
      f.service.sendMessage({
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
      f.service.sendMessage({
        text: "Written for the old session",
        expectedContext: "Global",
        expectedThreadId: f.global.threadId,
      }),
    );
    assert.equal(stale._tag === "Failure" && stale.failure.reason, "stale");
    assert.equal((yield* Ref.get(f.sends)).length, 0);
    const sent = yield* f.service.sendMessage({
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
    yield* f.service.sendMessage({
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
        Effect.result(f.service.sendMessage({ text: "Read dimaggi-thread", ...view })),
        Effect.result(f.service.sendMessage({ text: "Global-only draft", ...view })),
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
      yield* f.service.sendMessage({ text: "Original user command" });
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

it.effect("reports an agent-started completion, logs the delayed archive and undoes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      sessionIdleMinutes: null,
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
        yield* f.service.sendMessage({ text });
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
      yield* f.service.sendMessage({ text: "[[thread:target]] [[thread:foreign-thread]]" });
      const prompt = (yield* Ref.get(f.state)).transcript!.at(-1)!.text;
      assert.include(prompt, "Private (target)");
      assert.notInclude(prompt, "foreign-thread");
      assert.notInclude(prompt, "Foreign secret title");
      assert.equal((yield* Ref.get(f.sends)).length, 0);
      yield* f.service.sendMessage({
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
      yield* f.service.sendMessage({ text: "[[thread:target]] [[thread:foreign-thread]]" });
      assert.include((yield* Ref.get(f.state)).transcript!.at(-1)!.text, "Foreign secret title");
    }),
);

it.effect("archived references cannot switch context", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask", true, undefined, "/isolated/d4-agent", true, {
      projectContexts: { [target.projectId]: "Dimaggi" },
    });
    yield* Ref.update(f.shells, (all) => all.map((entry) => ({ ...entry, archivedAt: now })));
    yield* f.service.sendMessage({ text: "[[thread:target]]" });
    assert.equal((yield* Ref.get(f.state)).brainContext, "Global");
    assert.equal((yield* Ref.get(f.sends)).length, 1);
  }),
);

it.effect("send original is bound to the active run rather than the latest queued message", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.sendMessage({ text: "First original text exactly\n  preserved" });
    const first = (yield* Ref.get(f.sends))[0]!;
    yield* f.service.sendMessage({ text: "Later queued unrelated instruction" });
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

it.effect("heartbeat drafts discard spoofed originals and never borrow a prior user message", () =>
  Effect.gen(function* () {
    const f = yield* fixture("ask");
    yield* f.service.sendMessage({ text: "Prior unrelated request" });
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
    const card = yield* f.service.requestAction({
      type: "send",
      threadId: targetId,
      text: "Heartbeat draft",
      originalText: "Spoofed original",
    });
    assert.isTrue(card.action.type === "send" && card.action.originalText === undefined);
    assert.equal(
      (yield* Effect.result(
        f.service.resolveAction({ actionId: card.id, decision: "approve", sendOriginal: true }),
      ))._tag,
      "Failure",
    );
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
    const next = yield* f.service.sendMessage({ text: "[[thread:target]]" });
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
      yield* f.service.sendMessage({ text: "hello" });
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
        yield* f.service.sendMessage({ text: "ordinary message" });
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
      yield* f.service.sendMessage({ text: "Continue in the existing session" });
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
    const f = yield* fixture("ask");
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
    yield* f.service.sendMessage({ text: original });
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

it.effect.each(["create", "send"] as const)(
  "a rotated message survives a failed %s and a restart, then is delivered once",
  (failure) =>
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
      const original = "Pending request that must survive";
      yield* f.service.sendMessage({ text: original });
      const summary = (yield* Ref.get(f.state)).rotation!;
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
      }));
      yield* Ref.set(failure === "create" ? f.failCreate : f.failSend, true);
      yield* f.service.tick;
      const pending = (yield* Ref.get(f.state)).rotation;
      assert.equal(pending?.pendingText, original);
      assert.isDefined(pending?.targetThreadId);
      assert.equal(pending?.seedSummary, "Scoped summary");
      assert.isFalse((yield* Ref.get(f.sends)).some((entry) => entry.text === original));

      yield* Ref.set(f.failCreate, false);
      yield* Ref.set(f.failSend, false);
      const restarted = yield* f.restart;
      yield* restarted.tick;
      yield* restarted.tick;
      const state = yield* Ref.get(f.state);
      const deliveries = (yield* Ref.get(f.sends)).filter((entry) => entry.text === original);
      assert.equal(deliveries.length, 1);
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
        1,
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
