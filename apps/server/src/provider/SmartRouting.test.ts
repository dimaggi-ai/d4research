import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type ProviderRoute,
} from "@d4research/contracts";
import { DeepSeekAdapterV2Driver } from "@d4research/provider-deepseek/server";
import { DeepSeekSettings } from "@d4research/provider-deepseek/settings";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import migration from "../persistence/Migrations/074_RouteTelemetry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RouteTelemetry from "./RouteTelemetry.ts";
import * as SmartRouting from "./SmartRouting.ts";

const localId = ProviderInstanceId.make("local-deepseek");
const fallbackId = ProviderInstanceId.make("cloud-codex");
const selection = { instanceId: localId, model: "private-model" };
const fallbackSelection = { instanceId: fallbackId, model: "gpt-5" };
const config = Schema.decodeSync(DeepSeekSettings)({
  enabled: true,
  smartRouting: true,
  model: selection.model,
  fallbackInstanceId: fallbackId,
  fallbackModel: fallbackSelection.model,
});
const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");

function projection(route: ProviderRoute | null = null): OrchestrationV2ThreadProjection {
  const id = ThreadId.make("current-private-thread");
  return {
    thread: {
      id,
      projectId: ProjectId.make("private-project"),
      title: "Private thread",
      providerInstanceId: localId,
      modelSelection: selection,
      providerRoute: route,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: "/private/workspace",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    },
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
  };
}

function testLayer(
  options: {
    readonly history?: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly historyReads?: ThreadId[];
    readonly status?: number;
    readonly catalogModel?: string;
    readonly config?: Partial<DeepSeekSettings>;
    readonly missingFallback?: boolean;
    readonly fallbackEnabled?: boolean;
    readonly fallbackSupportsTools?: boolean;
    readonly fallbackAvailable?: boolean;
    readonly fallbackModels?: ReadonlyArray<string>;
    readonly localAvailable?: boolean;
    readonly requests?: string[];
  } = {},
) {
  const client = HttpClient.make((request) => {
    options.requests?.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            data: [{ id: options.catalogModel ?? config.model }],
          },
          { status: options.status ?? 200 },
        ),
      ),
    );
  });
  const registry = Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const local = yield* DeepSeekAdapterV2Driver.create({
        instanceId: localId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config,
      });
      const localCapabilities = yield* local.getCapabilities();
      const fallback = {
        ...local,
        instanceId: fallbackId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () =>
          Effect.succeed({
            ...localCapabilities,
            tools: {
              ...localCapabilities.tools,
              emitsToolStarted: options.fallbackSupportsTools ?? true,
            },
          }),
      };
      return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        ...(options.fallbackAvailable !== undefined || options.fallbackModels !== undefined
          ? {
              getMetadata: () =>
                Effect.succeed({
                  driver: fallback.driver,
                  continuationKey: "test-fallback",
                  enabled: true,
                  available: options.fallbackAvailable ?? true,
                  models: options.fallbackModels ?? [fallbackSelection.model],
                  capabilities: localCapabilities,
                }),
            }
          : {}),
        list: () =>
          Effect.succeed(options.localAvailable === false ? [fallbackId] : [localId, fallbackId]),
        get: (instanceId) =>
          instanceId === fallbackId && !options.missingFallback
            ? Effect.succeed(fallback)
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      });
    }),
  );
  const dependencies = Layer.mergeAll(
    registry,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getTurnStartHistory: (threadId) => {
        options.historyReads?.push(threadId);
        return Effect.succeed(options.history ?? []);
      },
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [localId]: {
          driver: ProviderDriverKind.make("deepseek"),
          enabled: true,
          config: { ...config, ...options.config },
        },
        [fallbackId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: options.fallbackEnabled ?? true,
          config: {},
        },
      },
    }),
    Layer.provideMerge(
      Layer.effectDiscard(migration),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  ).pipe(Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)));
  return Layer.provideMerge(Layer.mergeAll(SmartRouting.layer, RouteTelemetry.layer), dependencies);
}

const input = () => ({
  selection,
  projection: projection(),
  text: "SECRET prompt",
  hasAttachments: false,
});

it.effect("selects a healthy local model and probes only the configured loopback catalog", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const result = yield* routing.select(input());
    assert.deepEqual(result.selection, selection);
    assert.equal(result.route?.reason, "local_healthy");
    assert.equal(result.route?.health, "healthy");
    assert.equal(result.route?.fallbackCount, 0);
    assert.deepEqual(requests, ["http://127.0.0.1:8094/v1/models"]);
  }).pipe(Effect.provide(testLayer({ requests })));
});

it.effect.each([
  ["unhealthy HTTP response", { status: 503 }, "endpoint_unhealthy"],
  ["unadvertised model", { catalogModel: "other-model" }, "endpoint_unhealthy"],
  ["unavailable local adapter", { localAvailable: false }, "local_unavailable"],
] as const)("uses the configured fallback for %s", ([_label, options, reason]) =>
  Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const result = yield* routing.select(input());
    assert.deepEqual(result.selection, fallbackSelection);
    assert.equal(result.route?.reason, reason);
    assert.equal(result.route?.fallbackCount, 1);
  }).pipe(Effect.provide(testLayer(options))),
);

it.effect.each([
  ["recent_timeouts", "completed", true, 1000],
  ["recent_errors", "failed", false, 1000],
  ["recent_latency", "completed", false, 60001],
] as const)(
  "uses durable observations from other threads for %s",
  ([reason, outcome, timeout, latency]) =>
    Effect.gen(function* () {
      const telemetry = yield* RouteTelemetry.RouteTelemetry;
      const routing = yield* SmartRouting.SmartRouting;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(1000000);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      for (let index = 0; index < 3; index++) {
        const runId = `private-run-${index}`;
        yield* telemetry.recordStart({
          runId,
          threadId: `different-private-thread-${index}`,
          driver: "deepseek",
          instanceId: localId,
          model: config.model,
          reason: "local_healthy",
          health: "healthy",
          startedAt: nowMs - latency - 1,
        });
        yield* telemetry.recordEnd(runId, { endedAt: nowMs - 1, outcome, timeout });
      }
      const result = yield* routing.select(input());
      assert.equal(result.route?.reason, reason);
      assert.deepEqual(result.selection, fallbackSelection);
      const rows = yield* sql`SELECT * FROM provider_route_telemetry`;
      for (const privateText of [
        "SECRET prompt",
        "private-run",
        "different-private-thread",
        "/private/workspace",
        "private-model",
      ]) {
        assert.notInclude(JSON.stringify(rows), privateText);
      }
    }).pipe(Effect.provide(testLayer())),
);

it.effect("routes context pressure and attachments without probing the local endpoint", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const context = yield* routing.select({ ...input(), text: "x".repeat(30000) });
    assert.equal(context.route?.reason, "context_pressure");
    assert.deepEqual(context.selection, fallbackSelection);
    const attachment = yield* routing.select({ ...input(), hasAttachments: true });
    assert.equal(attachment.route?.reason, "task_requires_tools");
    assert.deepEqual(attachment.selection, fallbackSelection);
    assert.deepEqual(requests, []);
  }).pipe(Effect.provide(testLayer({ requests })));
});

it.effect.each([
  ["missing", { missingFallback: true }],
  ["disabled", { fallbackEnabled: false }],
  ["unconfigured", { config: { fallbackInstanceId: "" } }],
  ["the local source itself", { config: { fallbackInstanceId: localId } }],
  ["missing required tool support", { fallbackSupportsTools: false }],
  ["unavailable in adapter metadata", { fallbackAvailable: false }],
  ["missing its configured model", { fallbackModels: ["other-model"] }],
] as const)("fails closed when the fallback is %s", ([_label, options]) =>
  Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const result = yield* Effect.exit(routing.select({ ...input(), hasAttachments: true }));
    assert.isTrue(Exit.isFailure(result));
    assert.include(String(result), "SmartRoutingError");
    assert.notInclude(String(result), "SECRET prompt");
  }).pipe(Effect.provide(testLayer(options))),
);

it.effect("recovers the local source after a persisted fallback decision", () =>
  Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const previous: ProviderRoute = {
      source: selection,
      selected: fallbackSelection,
      driver: ProviderDriverKind.make("codex"),
      taskMode: "text",
      reason: "endpoint_unhealthy",
      health: "unhealthy",
      decidedAt: 0,
      contextTokens: 1000,
      fallbackCount: 2,
    };
    const result = yield* routing.select({
      ...input(),
      selection: fallbackSelection,
      projection: projection(previous),
    });
    assert.deepEqual(result.selection, selection);
    assert.deepEqual(result.route?.source, selection);
    assert.equal(result.route?.reason, "local_healthy");
    assert.equal(result.route?.fallbackCount, 2);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("honors smart routing opt-out and leaves an explicit cloud selection unchanged", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    assert.deepEqual(yield* routing.select(input()), { selection, route: null });
    assert.deepEqual(yield* routing.select({ ...input(), selection: fallbackSelection }), {
      selection: fallbackSelection,
      route: null,
    });
    assert.deepEqual(requests, []);
  }).pipe(Effect.provide(testLayer({ config: { smartRouting: false }, requests })));
});

it.effect("honors the per-selection tools override without probing local health", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const result = yield* routing.select({
      ...input(),
      selection: { ...selection, options: [{ id: "taskMode", value: "tools" }] },
    });
    assert.deepEqual(result.selection, fallbackSelection);
    assert.equal(result.route?.taskMode, "tools");
    assert.equal(result.route?.reason, "task_requires_tools");
    assert.deepEqual(requests, []);
  }).pipe(Effect.provide(testLayer({ requests })));
});

it.effect("counts assistant history when token usage and user-message history are absent", () => {
  const requests: string[] = [];
  const historyReads: ThreadId[] = [];
  const history: OrchestrationV2TurnItem = {
    id: TurnItemId.make("private-assistant-item"),
    type: "assistant_message",
    threadId: projection().thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make("private-assistant-message"),
    text: "PRIVATE-ASSISTANT-RESPONSE".repeat(1500),
    streaming: false,
  };
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const current = input();
    assert.equal(current.projection.providerTurns.length, 0);
    assert.equal(current.projection.messages.length, 0);
    const result = yield* routing.select(current);
    assert.equal(result.route?.reason, "context_pressure");
    assert.deepEqual(result.selection, fallbackSelection);
    assert.isAbove(result.route?.contextTokens ?? 0, 32768);
    assert.deepEqual(historyReads, [current.projection.thread.id]);
    assert.deepEqual(requests, []);
    const sql = yield* SqlClient.SqlClient;
    assert.notInclude(
      JSON.stringify(yield* sql`SELECT * FROM provider_route_telemetry`),
      "PRIVATE-ASSISTANT-RESPONSE",
    );
  }).pipe(Effect.provide(testLayer({ history: [history], historyReads, requests })));
});

it.effect("does not load durable history when smart routing is disabled", () => {
  const historyReads: ThreadId[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    assert.deepEqual(yield* routing.select(input()), { selection, route: null });
    assert.deepEqual(historyReads, []);
  }).pipe(Effect.provide(testLayer({ config: { smartRouting: false }, historyReads })));
});

it.effect("keeps Nia on its selected provider without probes, history reads, or fallback", () => {
  const requests: string[] = [];
  const historyReads: ThreadId[] = [];
  return Effect.gen(function* () {
    const routing = yield* SmartRouting.SmartRouting;
    const result = yield* routing.select({ ...input(), toolPolicy: "d4-agent" });
    assert.deepEqual(result, { selection, route: null });
    assert.deepEqual(requests, []);
    assert.deepEqual(historyReads, []);
  }).pipe(
    Effect.provide(
      testLayer({
        requests,
        historyReads,
        config: { taskMode: "tools" },
        missingFallback: true,
        localAvailable: false,
      }),
    ),
  );
});
