import { assert, it } from "@effect/vitest";
import {
  CommandId,
  D4AgentError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as D4AgentContext from "../d4Agent/D4AgentContext.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Validation must fail before opening a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const makeLayer = (reason: "context" | "model-unavailable" = "context") =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "terminal-start-failure" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      layerDatabase: database,
      runEffectWorker: false,
      layerD4AgentContext: Layer.succeed(D4AgentContext.D4AgentContext, {
        owns: () => Effect.succeed(false),
        prepare: () => Effect.fail(new D4AgentError({ reason })),
      }),
    },
  ).pipe(Layer.provideMerge(database));

const create = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:start-failure"),
      title: "Start failure",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );
const send = (threadId: ThreadId, suffix: string, queued = false) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${suffix}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${suffix}`),
      text: suffix,
      attachments: [],
      dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.effect.each(["context", "model-unavailable"] as const)(
  "terminal %s failure settles execution, shows the reason, and advances the queue",
  (reason) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:terminal-start-failure");
      yield* create(threadId);
      yield* send(threadId, "first");
      yield* send(threadId, "queued", true);
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      // Exercise the last durable attempt without waiting through retry backoff.
      yield* sql`UPDATE orchestration_v2_effect_outbox SET attempt_count = 4
      WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start'`;
      const sequence = yield* sink.latestSequence();
      yield* worker.drain(1);
      const failed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(failed.runs[0]?.status, "failed");
      assert.equal(failed.nodes.find((node) => node.id === first!.rootNodeId)?.status, "failed");
      assert.equal(
        failed.attempts.find((attempt) => attempt.id === first!.activeAttemptId)?.status,
        "failed",
      );
      assert.isDefined(failed.runs[0]?.completedAt);
      assert.equal(failed.providerTurns.length, 0);
      const error = failed.turnItems.find((item) => item.type === "error");
      assert.equal(
        error?.type === "error" ? error.failure.message : undefined,
        new D4AgentError({ reason }).message,
      );
      yield* sink.stream({ threadId, afterSequence: sequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === queued!.id &&
            event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status, "starting");
      const effects = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND payload_json LIKE ${`%${first!.id}%`}`;
      assert.deepEqual(
        effects.map((effect) => effect.status),
        ["failed"],
      );
    }).pipe(Effect.provide(makeLayer(reason))),
);

it.effect("interrupts a starting run without a provider turn and cancels its pending start", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make("thread:interrupt-before-start");
    yield* create(threadId);
    yield* send(threadId, "first");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    assert.equal(run.status, "starting");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt:start"),
      threadId,
      runId: run.id,
    });
    yield* worker.drain();
    const stopped = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(stopped.runs[0]?.status, "interrupted");
    assert.equal(stopped.attempts[0]?.status, "interrupted");
    assert.equal(stopped.nodes[0]?.status, "interrupted");
    assert.equal(stopped.providerTurns.length, 0);
    assert.equal(
      stopped.turnItems.filter((item) => item.type === "run_interrupt_result").length,
      1,
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a retryable startup failure starting without advancing its queued message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:retryable-start-failure");
    yield* create(threadId);
    yield* send(threadId, "first");
    yield* send(threadId, "queued", true);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      projection.runs.map((run) => run.status),
      ["starting", "queued"],
    );
    assert.equal(projection.turnItems.filter((item) => item.type === "error").length, 0);
    const effects = yield* sql<{ status: string; attempt_count: number }>`
      SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}`;
    assert.deepEqual(effects, [{ status: "pending", attempt_count: 1 }]);
  }).pipe(Effect.provide(makeLayer())),
);
