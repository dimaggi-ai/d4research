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
import * as TestClock from "effect/testing/TestClock";
import * as Agent from "./D4Agent.ts";
import * as Store from "./D4AgentStore.ts";
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
) =>
  Effect.gen(function* () {
    const catalog = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      providerAvailable ? [provider] : [],
    );
    const state = yield* Ref.make<Store.StoredState>({
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
    const agentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(null);
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
    const reads = yield* Ref.make({ updates: 0, snapshots: 0, probes: 0 });
    const layer = Agent.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.D4AgentStore, {
            workspace,
            get: Ref.get(state),
            update: (f) =>
              Ref.update(reads, (r) => ({ ...r, updates: r.updates + 1 })).pipe(
                Effect.andThen(Ref.updateAndGet(state, f)),
              ),
          }),
          Layer.succeed(Probe.SystemProbe, {
            check: () =>
              Ref.update(reads, (r) => ({ ...r, probes: r.probes + 1 })).pipe(
                Effect.andThen(Ref.get(checks)),
              ),
          }),
          Settings.layerTest({
            d4Agent: {
              ...DEFAULT_D4_AGENT_SETTINGS,
              enabled: true,
              modelSelection,
              permissionMode: mode,
              systemProbeEnabled: true,
            },
            agentMonitor: {
              enabled: monitorEnabled,
              notificationsEnabled: true,
              notifyClasses: ["system"],
            },
          }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Ref.get(catalog),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: (id) =>
              id === targetId ? Effect.succeed(target) : Ref.get(agentShell),
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [target],
                archivedThreads: [],
                snapshotSequence: 0,
                schemaVersion: 2,
              }),
            dispatch: (cmd) =>
              Ref.update(dispatches, (value) => [...value, cmd.type]).pipe(
                Effect.as({ sequence: 1, duplicate: false, storedEvents: [] }),
              ),
            interruptThread: () =>
              Ref.update(dispatches, (value) => [...value, "interrupt"]).pipe(
                Effect.as({ type: "no_active_run" as const }),
              ),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({
            getRuntimeRequest: () => Ref.get(request),
            getThreadSnapshotWindow: () =>
              Ref.update(reads, (r) => ({ ...r, snapshots: r.snapshots + 1 })).pipe(
                Effect.andThen(Ref.get(projection)),
                Effect.map((value) => ({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  projection: value,
                })),
              ),
          }),
          projectService === undefined
            ? Layer.mock(Projects.ProjectService)({})
            : Layer.succeed(Projects.ProjectService, projectService),
          Layer.mock(Monitor.AgentMonitorReactor)({ snapshot: Effect.succeed([]) }),
        ),
      ),
    );
    const service = yield* Agent.D4Agent.pipe(Effect.provide(layer));
    return { service, state, checks, request, dispatches, projection, catalog, reads, agentShell };
  });

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
    assert.deepEqual(yield* Ref.get(reads), { updates: 0, snapshots: 0, probes: 0 });
  }),
);

it.effect("state contains bounded unique summaries and full actions require detail fetch", () =>
  Effect.gen(function* () {
    const { service, state } = yield* fixture();
    const actions = Array.from({ length: 249 }, (_, i) => ({
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
        projectId: target.projectId,
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
    assert.deepEqual(yield* Ref.get(reads), { updates: 0, snapshots: 0, probes: 0 });
  }),
);
