import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2DomainEvent,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as AgentMonitor from "./AgentMonitorReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);
const services = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ServerSettings.layerTest(),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const clientId = "device:one";
const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const at = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");

function thread(id: string): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${id}`),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const enable = (notificationsEnabled = true) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      agentMonitor: {
        enabled: true,
        notificationsEnabled,
        modelSelection: null,
        stuckAfterMinutes: 10,
        notifyClasses: ["waiting", "stuck", "auth", "failed", "system"],
      },
    });
  });

const seed = (id: string, status: OrchestrationV2Run["status"] = "running") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const value = thread(id);
    const threadId = value.id;
    const runId = RunId.make(`run:${id}`);
    const nodeId = NodeId.make(`node:${id}`);
    const attemptId = RunAttemptId.make(`attempt:${id}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${id}`);
    const providerSessionId = ProviderSessionId.make(`session:${id}`);
    const providerTurnId = ProviderTurnId.make(`turn:${id}`);
    const base = { threadId, runId, providerInstanceId, occurredAt: at };
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* sink.write({
      events: [
        { ...base, id: EventId.make(`${id}:thread`), type: "thread.created", payload: value },
        { ...base, id: EventId.make(`${id}:run`), type: "run.created", payload: run },
        {
          ...base,
          id: EventId.make(`${id}:attempt`),
          type: "run-attempt.created",
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId,
            providerThreadId,
            providerTurnId,
            reason: "initial",
            status: "running",
            startedAt: at,
            completedAt: null,
          },
        },
        {
          ...base,
          id: EventId.make(`${id}:node`),
          type: "node.updated",
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: at,
            completedAt: null,
          },
        },
        {
          ...base,
          id: EventId.make(`${id}:session`),
          type: "provider-session.attached",
          driver,
          payload: {
            id: providerSessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: at,
            updatedAt: at,
            lastError: null,
          },
        },
        {
          ...base,
          id: EventId.make(`${id}:provider-thread`),
          type: "provider-thread.updated",
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: nodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
    });
    return { ...base, run, nodeId, attemptId, providerThreadId, providerTurnId };
  });
type Fixture = Effect.Success<ReturnType<typeof seed>>;

const pending = (fixture: Fixture, kind: OrchestrationV2RuntimeRequest["kind"] = "command") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const request: OrchestrationV2RuntimeRequest = {
      id: RuntimeRequestId.make(`request:${fixture.threadId}`),
      nodeId: fixture.nodeId,
      providerTurnId: fixture.providerTurnId,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: at,
      resolvedAt: null,
    };
    yield* sink.write({
      events: [
        {
          ...fixture,
          id: EventId.make(`${request.id}:pending`),
          type: "runtime-request.updated",
          payload: request,
        },
      ],
    });
    return request;
  });

const read = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    return yield* projection.getThread(threadId);
  });
const monitorEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events
    WHERE event_type = 'thread.monitor-updated' AND application_event_version = 2`)[0]!.count;
});
const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(services)));

it.effect(
  "requires opt-in, persists reports without changing updatedAt, and clears reports when disabled",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        const fixture = yield* seed("opt-in");
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        assert.equal(yield* monitorEventCount, 0);
        yield* enable();
        yield* monitor.sweep;
        const first = yield* read(fixture.threadId);
        assert.equal(first.agentMonitor?.classification, "working");
        assert.equal(DateTime.toEpochMillis(first.updatedAt), DateTime.toEpochMillis(at));
        yield* monitor.sweep;
        assert.equal(yield* monitorEventCount, 0);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          agentMonitor: {
            ...(yield* settings.getSettings).agentMonitor,
            enabled: false,
            notificationsEnabled: false,
          },
        });
        yield* monitor.sweep;
        assert.isNull((yield* read(fixture.threadId)).agentMonitor);
        assert.equal(yield* monitorEventCount, 0);
      }),
    ),
);

it.effect(
  "pending approval takes precedence over a usage limit on the current running attempt",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        yield* enable();
        const fixture = yield* seed("failure");
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              ...fixture,
              id: EventId.make("failure:item"),
              type: "turn-item.updated",
              payload: {
                id: TurnItemId.make("failure:item"),
                threadId: fixture.threadId,
                runId: fixture.runId,
                nodeId: fixture.nodeId,
                providerThreadId: fixture.providerThreadId,
                providerTurnId: fixture.providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: null,
                startedAt: at,
                completedAt: at,
                updatedAt: at,
                type: "error",
                failure: {
                  class: "usage_limit",
                  message: "Usage limit",
                  code: null,
                  retryable: false,
                },
              },
            },
          ],
        });
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor?.classification, "limited");
        yield* pending(fixture);
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor?.classification, "needs_user");
        const attemptId = RunAttemptId.make("failure:retry-attempt");
        yield* sink.write({
          events: [
            {
              ...fixture,
              id: EventId.make("failure:retry"),
              type: "run-attempt.created",
              payload: {
                id: attemptId,
                runId: fixture.runId,
                attemptOrdinal: 2,
                rootNodeId: fixture.nodeId,
                providerInstanceId,
                providerThreadId: fixture.providerThreadId,
                providerTurnId: ProviderTurnId.make("failure:retry-turn"),
                reason: "retry",
                status: "running",
                startedAt: at,
                completedAt: null,
              },
            },
            {
              ...fixture,
              id: EventId.make("failure:retry-active"),
              type: "run.updated",
              payload: { ...fixture.run, activeAttemptId: attemptId },
            },
          ],
        });
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor?.classification, "working");
      }),
    ),
);

it.effect("does not infer a wedged provider from a long expired unrenewed effect lease", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at) + 3_600_000);
      yield* enable();
      const fixture = yield* seed("lease");
      const sink = yield* EventSink.EventSinkV2;
      const commandId = CommandId.make("lease:command");
      yield* sink.commitCommand({
        commandId,
        threadId: fixture.threadId,
        commandType: "test",
        acceptedAt: at,
        events: [
          {
            ...fixture,
            id: EventId.make("lease:updated"),
            type: "run.updated",
            payload: fixture.run,
          },
        ],
        effects: [
          {
            id: "lease:effect",
            commandId,
            threadId: fixture.threadId,
            request: { type: "provider-turn.start", runId: fixture.runId },
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'worker',
      lease_expires_at = '2026-10-24T12:00:01.000Z' WHERE effect_id = 'lease:effect'`;
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor;
      assert.equal(report?.classification, "suspected_stuck");
      assert.isTrue(report!.attentionRequired);
      assert.isFalse(report!.notificationEligible);
    }),
  ),
);

it.effect("deduplicates claims per client durably while allowing another device", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const first = yield* AgentMonitor.make;
      yield* first.sweep;
      const fixture = yield* seed("restart");
      yield* pending(fixture);
      yield* first.sweep;
      const reportKey = (yield* read(fixture.threadId)).agentMonitor!.reportKey;
      const second = yield* AgentMonitor.make;
      yield* second.sweep;
      assert.equal(yield* monitorEventCount, 0);
      const input = { threadId: fixture.threadId, reportKey, clientId };
      const claims = yield* Effect.all(
        [first.claimAttention(input), second.claimAttention(input)],
        { concurrency: "unbounded" },
      );
      assert.equal(claims.filter((claim) => claim.claimed).length, 1);
      const restarted = yield* AgentMonitor.make;
      assert.isFalse((yield* restarted.claimAttention(input)).claimed);
      assert.isTrue(
        (yield* restarted.claimAttention({ ...input, clientId: "device:two" })).claimed,
      );
    }),
  ),
);

it.effect("rejects attention claims when notifications are disabled", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable(false);
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("silent");
      yield* pending(fixture);
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(report.notificationEligible);
      const reportKey = report.reportKey;
      assert.isFalse(
        (yield* monitor.claimAttention({ threadId: fixture.threadId, reportKey, clientId }))
          .claimed,
      );
    }),
  ),
);

it.effect(
  "rejects stale approval reports after resolution, a new attempt, or run completion before another sweep",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        const sink = yield* EventSink.EventSinkV2;
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        for (const transition of ["resolved", "attempt", "terminal"] as const) {
          const fixture = yield* seed(transition);
          const request = yield* pending(fixture);
          yield* monitor.sweep;
          const observed = (yield* read(fixture.threadId)).agentMonitor!;
          assert.isTrue(observed.notificationEligible);
          const reportKey = observed.reportKey;
          const event: OrchestrationV2DomainEvent =
            transition === "resolved"
              ? {
                  ...fixture,
                  id: EventId.make(`${transition}:changed`),
                  type: "runtime-request.updated",
                  payload: { ...request, status: "resolved", resolvedAt: at },
                }
              : {
                  ...fixture,
                  id: EventId.make(`${transition}:changed`),
                  type: "run.updated",
                  payload:
                    transition === "attempt"
                      ? { ...fixture.run, activeAttemptId: RunAttemptId.make("new-attempt") }
                      : { ...fixture.run, status: "completed", completedAt: at },
                };
          yield* sink.write({ events: [event] });
          assert.isFalse(
            (yield* monitor.claimAttention({ threadId: fixture.threadId, reportKey, clientId }))
              .claimed,
            transition,
          );
        }
      }),
    ),
);

it.effect("keeps reports out of event history, command receipts and replay cursors", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const fixture = yield* seed("history");
      const store = yield* EventStore.EventStoreV2;
      const sequence = yield* store.latestSequence({ threadId: fixture.threadId });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM orchestration_command_receipts`;
      const outbox = yield* sql`SELECT * FROM orchestration_v2_effect_outbox`;
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const first = yield* read(fixture.threadId);
      assert.isAbove(first.agentMonitorRevision!, 0);
      yield* pending(fixture);
      const pendingSequence = yield* store.latestSequence({ threadId: fixture.threadId });
      yield* monitor.sweep;
      const second = yield* read(fixture.threadId);
      assert.isAbove(second.agentMonitorRevision!, first.agentMonitorRevision!);
      assert.isAbove(pendingSequence, sequence);
      assert.equal(yield* store.latestSequence({ threadId: fixture.threadId }), pendingSequence);
      assert.equal(yield* monitorEventCount, 0);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_command_receipts`, before);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, outbox);
      const updates = yield* monitor.snapshot;
      const snapshot = updates.find((update) => update.threadId === fixture.threadId)!;
      assert.equal(snapshot.revision, second.agentMonitorRevision);
      assert.deepEqual(snapshot.report, second.agentMonitor);
      const restarted = yield* AgentMonitor.make;
      assert.deepEqual(yield* restarted.snapshot, updates);
    }),
  ),
);

it.effect(
  "rolls back report revisions and notification eligibility when projection writes fail",
  () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          yield* enable();
          yield* TestClock.setTime(DateTime.toEpochMillis(at));
          const monitor = yield* AgentMonitor.make;
          yield* monitor.sweep;
          const pull = yield* Stream.toPull(monitor.changes);
          const nextUpdate = yield* pull.pipe(Effect.forkScoped({ startImmediately: true }));
          const fixture = yield* seed("rollback");
          yield* pending(fixture);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER reject_monitor BEFORE UPDATE ON orchestration_v2_projection_threads
      WHEN json_extract(NEW.payload_json, '$.agentMonitor') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'monitor projection failure'); END`;
          const before = yield* monitor.snapshot;
          const controlBefore = yield* sql`SELECT revision FROM agent_monitor_control`;
          const failure = yield* Effect.flip(monitor.sweep);
          assert.equal(failure._tag, "AgentMonitorError");
          assert.notProperty(failure, "cause");
          yield* Effect.yieldNow;
          assert.isUndefined(nextUpdate.pollUnsafe());
          assert.equal(yield* monitorEventCount, 0);
          assert.isUndefined((yield* read(fixture.threadId)).agentMonitor);
          assert.deepEqual(yield* monitor.snapshot, before);
          assert.deepEqual(yield* sql`SELECT revision FROM agent_monitor_control`, controlBefore);
          assert.lengthOf(
            yield* sql`SELECT * FROM agent_monitor_observations WHERE thread_id = ${fixture.threadId}`,
            0,
          );
          assert.lengthOf(yield* sql`SELECT * FROM agent_monitor_device_claims`, 0);
          const receipts = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts
      WHERE command_type = 'thread.monitor.report'`;
          assert.equal(receipts[0]!.count, 0);
          yield* sql`DROP TRIGGER reject_monitor`;
          yield* monitor.sweep;
          const report = (yield* read(fixture.threadId)).agentMonitor!;
          assert.equal(report.classification, "needs_user");
          assert.isTrue(
            (yield* monitor.claimAttention({
              threadId: fixture.threadId,
              reportKey: report.reportKey,
              clientId,
            })).claimed,
          );
          const updates = yield* Fiber.join(nextUpdate);
          assert.lengthOf(updates, 1);
          assert.equal(updates[0]!.revision, (yield* read(fixture.threadId)).agentMonitorRevision);
          assert.equal(updates[0]!.report!.reportKey, report.reportKey);
        }),
      ),
    ),
);

it.effect(
  "sweeps 205 active threads without provider dependencies or unchanged revision churn",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        for (let index = 0; index < 205; index++) yield* seed(`many:${index}`);
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        assert.equal(yield* monitorEventCount, 0);
        const before = yield* monitor.snapshot;
        yield* monitor.sweep;
        assert.deepEqual(yield* monitor.snapshot, before);
        assert.equal(yield* monitorEventCount, 0);
        assert.equal(
          (yield* read(ThreadId.make("many:204"))).agentMonitor?.classification,
          "working",
        );
      }),
    ),
);

it.effect("distinguishes failed runs from dynamic tool calls waiting for background work", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const fixture = yield* seed("background", "failed");
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      assert.equal((yield* read(fixture.threadId)).agentMonitor?.classification, "failed");
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("background:running"),
            type: "run.updated",
            payload: { ...fixture.run, status: "running" },
          },
        ],
      });
      yield* pending(fixture, "dynamic_tool_call");
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor;
      assert.equal(report?.classification, "waiting_background");
      assert.isFalse(report!.attentionRequired);
    }),
  ),
);

it.effect(
  "preserves a persisted monitor report when a stale whole-thread metadata update arrives",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        const fixture = yield* seed("stale-metadata");
        const stale = yield* read(fixture.threadId);
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const persistedThread = yield* read(fixture.threadId);
        const persisted = persistedThread.agentMonitor;
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              ...fixture,
              id: EventId.make("stale-metadata:update"),
              type: "thread.metadata-updated",
              payload: { ...stale, title: "Updated title" },
            },
          ],
        });
        const updated = yield* read(fixture.threadId);
        assert.equal(updated.title, "Updated title");
        assert.deepEqual(updated.agentMonitor, persisted);
        assert.equal(updated.agentMonitorRevision, persistedThread.agentMonitorRevision);
      }),
    ),
);

it.effect(
  "reports pending secrets without exposing their label and rejects saved-secret alerts",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const fixture = yield* seed("secret");
        const sink = yield* EventSink.EventSinkV2;
        const item = {
          id: TurnItemId.make("secret:item"),
          threadId: fixture.threadId,
          runId: fixture.runId,
          nodeId: fixture.nodeId,
          providerThreadId: fixture.providerThreadId,
          providerTurnId: fixture.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting" as const,
          title: "PRIVATE_TITLE",
          startedAt: at,
          completedAt: null,
          updatedAt: at,
          type: "secret_request" as const,
          label: "PRIVATE_LABEL",
          reason: "PRIVATE_REASON",
          secretStatus: "pending" as const,
        };
        yield* sink.write({
          events: [
            {
              ...fixture,
              id: EventId.make("secret:requested"),
              type: "turn-item.updated",
              payload: item,
            },
          ],
        });
        yield* monitor.sweep;
        const report = (yield* read(fixture.threadId)).agentMonitor!;
        assert.equal(report.classification, "needs_user");
        assert.isTrue(report.notificationEligible);
        assert.notInclude(Object.values(report).join(" "), "PRIVATE_");
        yield* sink.write({
          events: [
            {
              ...fixture,
              id: EventId.make("secret:saved"),
              type: "turn-item.updated",
              payload: { ...item, status: "completed", secretStatus: "saved" },
            },
          ],
        });
        assert.isFalse(
          (yield* monitor.claimAttention({
            threadId: fixture.threadId,
            reportKey: report.reportKey,
            clientId,
          })).claimed,
        );
      }),
    ),
);

it.effect("keeps completed foreground runs waiting for surviving background work", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const fixture = yield* seed("surviving-background", "completed");
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("background:tool"),
            type: "turn-item.updated",
            payload: {
              id: TurnItemId.make("background:tool"),
              threadId: fixture.threadId,
              runId: fixture.runId,
              nodeId: fixture.nodeId,
              providerThreadId: fixture.providerThreadId,
              providerTurnId: fixture.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "PRIVATE_TOOL",
              startedAt: at,
              completedAt: null,
              updatedAt: at,
              type: "dynamic_tool",
              toolName: "PRIVATE_TOOL",
              input: { sensitive: "PRIVATE_INPUT" },
            },
          },
        ],
      });
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.equal(report.classification, "waiting_background");
      assert.isFalse(report.attentionRequired);
      assert.notInclude(Object.values(report).join(" "), "PRIVATE_");
    }),
  ),
);

it.effect("silences initial attention across restart until the evidence changes", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      const fixture = yield* seed("baseline", "failed");
      yield* enable();
      const initial = yield* AgentMonitor.make;
      yield* initial.sweep;
      const baseline = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(baseline.attentionRequired);
      assert.isFalse(baseline.notificationEligible);
      yield* TestClock.adjust("31 seconds");
      const restarted = yield* AgentMonitor.make;
      yield* restarted.sweep;
      assert.equal((yield* read(fixture.threadId)).agentMonitor!.reportKey, baseline.reportKey);
      assert.isFalse(
        (yield* restarted.claimAttention({
          threadId: fixture.threadId,
          reportKey: baseline.reportKey,
          clientId,
        })).claimed,
      );
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("baseline:running"),
            type: "run.updated",
            payload: { ...fixture.run, status: "running" },
          },
        ],
      });
      yield* pending(fixture);
      yield* restarted.sweep;
      const changed = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(changed.notificationEligible);
      assert.isTrue(
        (yield* restarted.claimAttention({
          threadId: fixture.threadId,
          reportKey: changed.reportKey,
          clientId,
        })).claimed,
      );
    }),
  ),
);

it.effect(
  "expires unclaimed attention after five minutes without reviving an unchanged report",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        yield* enable();
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const fixture = yield* seed("expired");
        yield* pending(fixture);
        yield* monitor.sweep;
        const report = (yield* read(fixture.threadId)).agentMonitor!;
        assert.isTrue(report.notificationEligible);
        yield* TestClock.adjust("5 minutes");
        yield* TestClock.adjust(1);
        assert.isFalse(
          (yield* monitor.claimAttention({
            threadId: fixture.threadId,
            reportKey: report.reportKey,
            clientId,
          })).claimed,
        );
        yield* monitor.sweep;
        assert.isFalse((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        const restarted = yield* AgentMonitor.make;
        yield* restarted.sweep;
        assert.isFalse(
          (yield* restarted.claimAttention({
            threadId: fixture.threadId,
            reportKey: report.reportKey,
            clientId: "new-device",
          })).claimed,
        );
      }),
    ),
);

it.effect(
  "requires continuous suspicious evidence and resets after recovery, sleep, or clock reversal",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        yield* enable();
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const fixture = yield* seed("suspicious");
        yield* monitor.sweep;
        const sql = yield* SqlClient.SqlClient;
        const setStatus = (status: string) =>
          sql`UPDATE orchestration_v2_projection_provider_sessions SET status = ${status} WHERE provider_session_id = ${`session:${fixture.threadId}`}`;
        yield* setStatus("error");
        yield* monitor.sweep;
        const candidate = (yield* read(fixture.threadId)).agentMonitor!;
        assert.equal(candidate.classification, "wedged");
        assert.isTrue(candidate.attentionRequired);
        assert.isFalse(candidate.notificationEligible);
        yield* TestClock.adjust("29 seconds");
        yield* monitor.sweep;
        assert.isFalse((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* TestClock.adjust("1 second");
        yield* monitor.sweep;
        assert.isTrue((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* setStatus("running");
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor!.classification, "working");
        assert.isFalse(
          (yield* monitor.claimAttention({
            threadId: fixture.threadId,
            reportKey: candidate.reportKey,
            clientId,
          })).claimed,
        );
        yield* setStatus("error");
        yield* monitor.sweep;
        assert.isFalse((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* TestClock.adjust("61 seconds");
        yield* monitor.sweep;
        assert.isFalse((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* TestClock.adjust("30 seconds");
        yield* monitor.sweep;
        assert.isTrue((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* TestClock.setTime(DateTime.toEpochMillis(at) + 100_000);
        yield* monitor.sweep;
        assert.isFalse((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
        yield* TestClock.adjust("30 seconds");
        yield* monitor.sweep;
        assert.isTrue((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
      }),
    ),
);

it.effect("requires repeated stale-progress observations before notification eligibility", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("stale-progress");
      yield* monitor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* monitor.sweep;
      const first = (yield* read(fixture.threadId)).agentMonitor!;
      assert.equal(first.classification, "suspected_stuck");
      assert.isTrue(first.attentionRequired);
      assert.isFalse(first.notificationEligible);
      yield* TestClock.adjust("15 seconds");
      yield* monitor.sweep;
      yield* TestClock.adjust("15 seconds");
      yield* monitor.sweep;
      const eligible = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(eligible.notificationEligible);
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: eligible.reportKey,
          clientId,
        })).claimed,
      );
      yield* TestClock.adjust("61 seconds");
      assert.isFalse(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: eligible.reportKey,
          clientId: "late-device",
        })).claimed,
      );
    }),
  ),
);

it.effect(
  "repairs malformed and future reports independently while preserving healthy threads",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        yield* enable();
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const malformed = yield* seed("malformed");
        const future = yield* seed("future");
        const healthy = yield* seed("healthy");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.agentMonitor', 'not-json') WHERE thread_id = ${malformed.threadId}`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.agentMonitor', json('{"schemaVersion":999}')) WHERE thread_id = ${future.threadId}`;
        const before = yield* monitor.snapshot;
        assert.isUndefined(before.find((update) => update.threadId === malformed.threadId));
        assert.isUndefined(before.find((update) => update.threadId === future.threadId));
        yield* monitor.sweep;
        for (const fixture of [malformed, future, healthy]) {
          assert.equal((yield* read(fixture.threadId)).agentMonitor!.classification, "working");
        }
        const revisions = (yield* monitor.snapshot).map((update) => update.revision);
        assert.equal(new Set(revisions).size, 3);
        assert.equal(yield* monitorEventCount, 0);
      }),
    ),
);

it.effect("does not create idle reports or revisions for runless threads", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const sink = yield* EventSink.EventSinkV2;
      const idle = thread("runless");
      yield* sink.write({
        events: [
          {
            id: EventId.make("runless:created"),
            threadId: idle.id,
            providerInstanceId,
            occurredAt: at,
            type: "thread.created",
            payload: idle,
          },
        ],
      });
      const monitor = yield* AgentMonitor.make;
      const before = yield* monitor.snapshot;
      yield* monitor.sweep;
      yield* monitor.sweep;
      assert.deepEqual(yield* monitor.snapshot, before);
      assert.isUndefined((yield* read(idle.id)).agentMonitor);
      assert.equal(yield* monitorEventCount, 0);
    }),
  ),
);

it.effect("decodes legacy monitor events with notifications disabled by default", () =>
  isolated(
    Effect.gen(function* () {
      const legacy = yield* decodeDomainEvent({
        id: EventId.make("legacy:report"),
        threadId: ThreadId.make("legacy"),
        occurredAt: at,
        type: "thread.monitor-updated",
        payload: {
          report: {
            schemaVersion: 1,
            runId: null,
            attemptId: null,
            classification: "failed",
            reason: "run_failed",
            attentionRequired: true,
            reportKey: "legacy",
            observedAt: "2026-10-24T12:00:00.000Z",
            runStatus: "failed",
            pendingRequestId: null,
          },
        },
      });
      assert.equal(legacy.type, "thread.monitor-updated");
      if (legacy.type === "thread.monitor-updated")
        assert.isFalse(legacy.payload.report!.notificationEligible);
    }),
  ),
);

it.effect("rolls child attention into its top-level parent without child reports or claims", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const parent = yield* seed("rollup-parent");
      const child = yield* seed("rollup-child");
      const nested = yield* seed("rollup-nested");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
      '$.lineage.parentThreadId', ${parent.threadId}, '$.lineage.relationshipToParent', 'subagent') WHERE thread_id=${child.threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
      '$.lineage.parentThreadId', ${child.threadId}, '$.lineage.relationshipToParent', 'subagent') WHERE thread_id=${nested.threadId}`;
      yield* pending(nested);
      yield* monitor.sweep;
      const report = (yield* read(parent.threadId)).agentMonitor!;
      assert.equal(report.classification, "needs_user");
      assert.equal(report.runId, nested.runId);
      assert.isUndefined((yield* read(child.threadId)).agentMonitor);
      assert.isUndefined((yield* read(nested.threadId)).agentMonitor);
      assert.deepEqual(
        (yield* monitor.snapshot).map((row) => row.threadId),
        [parent.threadId],
      );
      assert.isFalse(
        (yield* monitor.claimAttention({
          threadId: nested.threadId,
          reportKey: report.reportKey,
          clientId,
        })).claimed,
      );
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: parent.threadId,
          reportKey: report.reportKey,
          clientId,
        })).claimed,
      );
    }),
  ),
);

it.effect(
  "gives recovered and changed-reason stalls new keys while continuous restart keeps the key",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at));
        yield* enable();
        let monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const fixture = yield* seed("episodes");
        const sql = yield* SqlClient.SqlClient;
        const status = (value: string) =>
          sql`UPDATE orchestration_v2_projection_provider_sessions SET status=${value} WHERE thread_id=${fixture.threadId}`;
        yield* status("error");
        yield* monitor.sweep;
        const first = (yield* read(fixture.threadId)).agentMonitor!;
        yield* TestClock.adjust("30 seconds");
        yield* monitor.sweep;
        assert.isTrue(
          (yield* monitor.claimAttention({
            threadId: fixture.threadId,
            reportKey: first.reportKey,
            clientId,
          })).claimed,
        );
        monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor!.reportKey, first.reportKey);
        yield* status("running");
        yield* monitor.sweep;
        yield* status("error");
        yield* monitor.sweep;
        const second = (yield* read(fixture.threadId)).agentMonitor!;
        assert.notEqual(second.reportKey, first.reportKey);
        yield* TestClock.adjust("30 seconds");
        yield* monitor.sweep;
        assert.isTrue(
          (yield* monitor.claimAttention({
            threadId: fixture.threadId,
            reportKey: second.reportKey,
            clientId,
          })).claimed,
        );
        yield* status("stopped");
        yield* monitor.sweep;
        const third = (yield* read(fixture.threadId)).agentMonitor!;
        assert.equal(third.reason, "provider_absent");
        assert.notEqual(third.reportKey, second.reportKey);
        assert.lengthOf(yield* sql`SELECT * FROM agent_monitor_device_claims`, 0);
      }),
    ),
);

it.effect("never revives an expired suspicious episode after restart for a new device", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const first = yield* AgentMonitor.make;
      yield* first.sweep;
      const fixture = yield* seed("restart-expired");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status='error' WHERE thread_id=${fixture.threadId}`;
      yield* first.sweep;
      yield* TestClock.adjust("30 seconds");
      yield* first.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(report.notificationEligible);
      yield* TestClock.adjust("10 minutes");
      const restarted = yield* AgentMonitor.make;
      yield* restarted.sweep;
      yield* TestClock.adjust("30 seconds");
      yield* restarted.sweep;
      const persisted = (yield* read(fixture.threadId)).agentMonitor!;
      assert.equal(persisted.reportKey, report.reportKey);
      assert.isFalse(persisted.notificationEligible);
      assert.isFalse(
        (yield* restarted.claimAttention({
          threadId: fixture.threadId,
          reportKey: report.reportKey,
          clientId: "never-claimed",
        })).claimed,
      );
    }),
  ),
);

it.effect("prunes expired claims even when the current report stays unchanged", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("prune");
      yield* pending(fixture);
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: report.reportKey,
          clientId,
        })).claimed,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT * FROM agent_monitor_device_claims`, 1);
      yield* TestClock.adjust("6 minutes");
      yield* monitor.sweep;
      assert.lengthOf(yield* sql`SELECT * FROM agent_monitor_device_claims`, 0);
    }),
  ),
);

it.effect("legacy monitor replay advances the revision beyond the derived report", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const fixture = yield* seed("legacy-revision");
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const before = yield* read(fixture.threadId);
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("legacy-revision:clear"),
            type: "thread.monitor-updated",
            payload: { report: null },
          },
        ],
      });
      const after = yield* read(fixture.threadId);
      assert.isNull(after.agentMonitor);
      assert.isAbove(after.agentMonitorRevision!, before.agentMonitorRevision!);
    }),
  ),
);

it.effect(
  "disabled snapshots have no rows and runless threads do not inflate enabled snapshots",
  () =>
    isolated(
      Effect.gen(function* () {
        const fixture = yield* seed("snapshot-enabled");
        const monitor = yield* AgentMonitor.make;
        assert.deepEqual(yield* monitor.snapshot, []);
        yield* enable();
        yield* monitor.sweep;
        assert.deepEqual(
          (yield* monitor.snapshot).map((row) => row.threadId),
          [fixture.threadId],
        );
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          agentMonitor: { ...(yield* settings.getSettings).agentMonitor, enabled: false },
        });
        assert.deepEqual(yield* monitor.snapshot, []);
      }),
    ),
);

it.effect("new progress permits a second stale episode in the same attempt", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("stale-twice");
      yield* monitor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* monitor.sweep;
      yield* TestClock.adjust("30 seconds");
      yield* monitor.sweep;
      const first = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: first.reportKey,
          clientId,
        })).claimed,
      );
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("stale-twice:progress"),
            type: "turn-item.updated",
            payload: {
              id: TurnItemId.make("stale-twice:item"),
              threadId: fixture.threadId,
              runId: fixture.runId,
              nodeId: fixture.nodeId,
              providerThreadId: fixture.providerThreadId,
              providerTurnId: fixture.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: at,
              completedAt: DateTime.add(at, { minutes: 10, seconds: 30 }),
              updatedAt: DateTime.add(at, { minutes: 10, seconds: 30 }),
              type: "dynamic_tool",
              toolName: "test",
              input: {},
            },
          },
        ],
      });
      yield* monitor.sweep;
      assert.equal((yield* read(fixture.threadId)).agentMonitor!.classification, "working");
      yield* TestClock.adjust("10 minutes");
      yield* monitor.sweep;
      yield* TestClock.adjust("30 seconds");
      yield* monitor.sweep;
      const second = (yield* read(fixture.threadId)).agentMonitor!;
      assert.equal(second.classification, "suspected_stuck");
      assert.equal(second.attemptId, first.attemptId);
      assert.notEqual(second.reportKey, first.reportKey);
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: second.reportKey,
          clientId,
        })).claimed,
      );
    }),
  ),
);

it.effect("notification class controls preserve attention in the digest and gate claims", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("class-filter");
      yield* pending(fixture, "auth_refresh");
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        agentMonitor: { ...(yield* settings.getSettings).agentMonitor, notifyClasses: ["waiting"] },
      });
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.isTrue(report.attentionRequired);
      assert.isFalse(report.notificationEligible);
      assert.isFalse(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: report.reportKey,
          clientId,
        })).claimed,
      );
      yield* settings.updateSettings({
        agentMonitor: { ...(yield* settings.getSettings).agentMonitor, notifyClasses: ["auth"] },
      });
      yield* monitor.sweep;
      assert.isTrue((yield* read(fixture.threadId)).agentMonitor!.notificationEligible);
    }),
  ),
);

it.effect("ignores orphan children and removes an archived child's rolled-up attention", () =>
  isolated(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const parent = yield* seed("archive-parent");
      const child = yield* seed("archive-child");
      const orphan = yield* seed("orphan-child");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
      '$.lineage.parentThreadId', ${parent.threadId}, '$.lineage.relationshipToParent', 'subagent') WHERE thread_id=${child.threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
      '$.lineage.relationshipToParent', 'subagent') WHERE thread_id=${orphan.threadId}`;
      yield* pending(child);
      yield* pending(orphan);
      yield* monitor.sweep;
      assert.equal((yield* read(parent.threadId)).agentMonitor!.classification, "needs_user");
      assert.deepEqual(
        (yield* monitor.snapshot).map((row) => row.threadId),
        [parent.threadId],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at='2026-10-24T12:00:00.000Z' WHERE thread_id=${child.threadId}`;
      yield* monitor.sweep;
      assert.equal((yield* read(parent.threadId)).agentMonitor!.classification, "working");
      assert.isUndefined((yield* read(orphan.threadId)).agentMonitor);
    }),
  ),
);

it.effect("completed notifications are explicit opt-in and never emitted for runless threads", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        agentMonitor: {
          ...(yield* settings.getSettings).agentMonitor,
          notifyClasses: ["completed"],
        },
      });
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const fixture = yield* seed("completed-opt-in", "completed");
      yield* monitor.sweep;
      const report = (yield* read(fixture.threadId)).agentMonitor!;
      assert.equal(report.classification, "idle");
      assert.isTrue(report.notificationEligible);
      assert.isTrue(
        (yield* monitor.claimAttention({
          threadId: fixture.threadId,
          reportKey: report.reportKey,
          clientId,
        })).claimed,
      );
    }),
  ),
);

it.effect("moves rolled-up attention immediately when a child changes parents", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const first = yield* seed("first-parent");
      const second = yield* seed("second-parent");
      const child = yield* seed("moving-child");
      const sql = yield* SqlClient.SqlClient;
      const move = (
        parentId: ThreadId,
      ) => sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,
      '$.lineage.parentThreadId', ${parentId}, '$.lineage.relationshipToParent', 'subagent') WHERE thread_id=${child.threadId}`;
      yield* move(first.threadId);
      yield* pending(child);
      yield* monitor.sweep;
      assert.equal((yield* read(first.threadId)).agentMonitor!.classification, "needs_user");
      yield* move(second.threadId);
      yield* monitor.sweep;
      assert.equal((yield* read(first.threadId)).agentMonitor!.classification, "working");
      assert.equal((yield* read(second.threadId)).agentMonitor!.classification, "needs_user");
    }),
  ),
);
