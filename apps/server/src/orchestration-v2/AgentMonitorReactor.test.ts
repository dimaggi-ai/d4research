import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
      agentMonitor: { enabled: true, notificationsEnabled, modelSelection: null },
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
        assert.equal(yield* monitorEventCount, 1);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          agentMonitor: { enabled: false, notificationsEnabled: false, modelSelection: null },
        });
        yield* monitor.sweep;
        assert.isNull((yield* read(fixture.threadId)).agentMonitor);
        assert.equal(yield* monitorEventCount, 2);
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
      assert.isFalse(report!.attentionRequired);
    }),
  ),
);

it.effect(
  "reconstructs a reactor against durable reports and grants one notification across clients and restart",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        const fixture = yield* seed("restart");
        yield* pending(fixture);
        const first = yield* AgentMonitor.make;
        yield* first.sweep;
        const reportKey = (yield* read(fixture.threadId)).agentMonitor!.reportKey;
        const second = yield* AgentMonitor.make;
        yield* second.sweep;
        assert.equal(yield* monitorEventCount, 1);
        const input = { threadId: fixture.threadId, reportKey };
        const claims = yield* Effect.all(
          [first.claimAttention(input), second.claimAttention(input)],
          { concurrency: "unbounded" },
        );
        assert.equal(claims.filter((claim) => claim.claimed).length, 1);
        const restarted = yield* AgentMonitor.make;
        assert.isFalse((yield* restarted.claimAttention(input)).claimed);
      }),
    ),
);

it.effect("rejects attention claims when notifications are disabled", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable(false);
      const fixture = yield* seed("silent");
      yield* pending(fixture);
      const monitor = yield* AgentMonitor.make;
      yield* monitor.sweep;
      const reportKey = (yield* read(fixture.threadId)).agentMonitor!.reportKey;
      assert.isFalse(
        (yield* monitor.claimAttention({ threadId: fixture.threadId, reportKey })).claimed,
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
        for (const transition of ["resolved", "attempt", "terminal"] as const) {
          const fixture = yield* seed(transition);
          const request = yield* pending(fixture);
          yield* monitor.sweep;
          const reportKey = (yield* read(fixture.threadId)).agentMonitor!.reportKey;
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
            (yield* monitor.claimAttention({ threadId: fixture.threadId, reportKey })).claimed,
            transition,
          );
        }
      }),
    ),
);

it.effect("rejects a stale event-sink observation atomically after a thread update", () =>
  isolated(
    Effect.gen(function* () {
      yield* enable();
      const fixture = yield* seed("fence");
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* EventStore.EventStoreV2;
      const expectedThreadSequence = yield* store.latestSequence({ threadId: fixture.threadId });
      const current = yield* read(fixture.threadId);
      yield* sink.write({
        events: [
          {
            ...fixture,
            id: EventId.make("fence:metadata"),
            type: "thread.metadata-updated",
            payload: { ...current, title: "Changed" },
          },
        ],
      });
      const result = yield* sink.commitCommand({
        expectedThreadSequence,
        commandId: CommandId.make("fence:stale"),
        threadId: fixture.threadId,
        commandType: "thread.monitor.report",
        acceptedAt: at,
        events: [
          {
            ...fixture,
            id: EventId.make("fence:report"),
            type: "thread.monitor-updated",
            payload: { report: null },
          },
        ],
        effects: [],
      });
      assert.isFalse(result.committed);
      assert.lengthOf(result.storedEvents, 0);
      assert.equal(yield* monitorEventCount, 0);
      assert.equal((yield* read(fixture.threadId)).title, "Changed");
    }),
  ),
);

it.effect(
  "rolls back the event and receipt when the monitor projection write fails, then retries",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        const fixture = yield* seed("rollback");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_monitor BEFORE UPDATE ON orchestration_v2_projection_threads
      WHEN json_extract(NEW.payload_json, '$.agentMonitor') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'monitor projection failure'); END`;
        const monitor = yield* AgentMonitor.make;
        const failure = yield* Effect.flip(monitor.sweep);
        assert.equal(failure._tag, "AgentMonitorError");
        assert.notProperty(failure, "cause");
        assert.equal(yield* monitorEventCount, 0);
        assert.isUndefined((yield* read(fixture.threadId)).agentMonitor);
        const receipts = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts
      WHERE command_type = 'thread.monitor.report'`;
        assert.equal(receipts[0]!.count, 0);
        yield* sql`DROP TRIGGER reject_monitor`;
        yield* monitor.sweep;
        assert.equal((yield* read(fixture.threadId)).agentMonitor?.classification, "working");
      }),
    ),
);

it.effect(
  "sweeps 205 active threads without provider dependencies or duplicate unchanged events",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
        for (let index = 0; index < 205; index++) yield* seed(`many:${index}`);
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        assert.equal(yield* monitorEventCount, 205);
        yield* monitor.sweep;
        assert.equal(yield* monitorEventCount, 205);
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
        const persisted = (yield* read(fixture.threadId)).agentMonitor;
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
      }),
    ),
);

it.effect(
  "reports pending secrets without exposing their label and rejects saved-secret alerts",
  () =>
    isolated(
      Effect.gen(function* () {
        yield* enable();
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
        const monitor = yield* AgentMonitor.make;
        yield* monitor.sweep;
        const report = (yield* read(fixture.threadId)).agentMonitor!;
        assert.equal(report.classification, "needs_user");
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
