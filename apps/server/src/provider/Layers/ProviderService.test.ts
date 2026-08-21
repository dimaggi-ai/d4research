// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let sessionStartCount = 0;
  let beforeStart: (() => Effect.Effect<void>) | undefined;
  let beforeSend: (() => Effect.Effect<void>) | undefined;
  let beforeStop: (() => Effect.Effect<void>) | undefined;

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    (beforeStart?.() ?? Effect.void).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const wasActive = sessions.has(input.threadId);
          sessionStartCount += 1;
          const now = wasActive ? "2026-01-01T00:00:00.001Z" : "2026-01-01T00:00:00.000Z";
          const session: ProviderSession = {
            provider,
            ...(input.providerInstanceId !== undefined
              ? { providerInstanceId: input.providerInstanceId }
              : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            resumeCursor: input.resumeCursor ?? {
              opaque: `resume-${String(input.threadId)}`,
            },
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(session.threadId, session);
          return { session, wasActive };
        }),
      ),
      Effect.flatMap(({ session, wasActive }) =>
        wasActive
          ? PubSub.publish(runtimeEventPubSub, {
              eventId: asEventId(`fake-session-started-${sessionStartCount}`),
              provider,
              ...(input.providerInstanceId !== undefined
                ? { providerInstanceId: input.providerInstanceId }
                : {}),
              threadId: input.threadId,
              createdAt: "2026-01-01T00:00:00.001Z",
              type: "session.started",
              payload: { message: "fake session restarted" },
            } satisfies ProviderRuntimeEvent).pipe(Effect.as(session))
          : Effect.succeed(session),
      ),
    ),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      return (beforeSend?.() ?? Effect.void).pipe(
        Effect.andThen(
          sessions.has(input.threadId)
            ? Effect.succeed({
                threadId: input.threadId,
                turnId: TurnId.make(`turn-${String(input.threadId)}`),
              })
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({
                  provider,
                  threadId: input.threadId,
                }),
              ),
        ),
      );
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      (beforeStop?.() ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            sessions.delete(threadId);
          }),
        ),
      ),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    setStartGate: (gate: (() => Effect.Effect<void>) | undefined) => {
      beforeStart = gate;
    },
    setSendGate: (gate: (() => Effect.Effect<void>) | undefined) => {
      beforeSend = gate;
    },
    setStopGate: (gate: (() => Effect.Effect<void>) | undefined) => {
      beforeStop = gate;
    },
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

function makeFailingProviderSessionDirectory() {
  const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>();
  let failNextUpsert = false;
  let failNextListBindings = false;
  const directory: ProviderSessionDirectory.ProviderSessionDirectoryShape = {
    upsert: (binding) =>
      Effect.gen(function* () {
        if (failNextUpsert) {
          failNextUpsert = false;
          return yield* new ProviderValidationError({
            operation: "test.directory.upsert",
            issue: "simulated persistence failure",
          });
        }
        bindings.set(binding.threadId, binding);
      }),
    getProvider: (threadId) => Effect.succeed(bindings.get(threadId)?.provider ?? CODEX_DRIVER),
    getBinding: (threadId) => Effect.succeed(Option.fromNullishOr(bindings.get(threadId))),
    listThreadIds: () => Effect.succeed(Array.from(bindings.keys())),
    listBindings: () =>
      failNextListBindings
        ? Effect.gen(function* () {
            failNextListBindings = false;
            return yield* new ProviderSessionDirectoryPersistenceError({
              operation: "test.directory.listBindings",
              detail: "simulated initial directory failure",
            });
          })
        : Effect.succeed(
            Array.from(bindings.values()).map((binding) => ({
              ...binding,
              lastSeenAt: "2026-01-01T00:00:00.000Z",
            })),
          ),
    replace: (binding) =>
      Effect.sync(() => {
        bindings.set(binding.threadId, binding);
      }),
  };
  return {
    directory,
    failNextUpsert: () => {
      failNextUpsert = true;
    },
    failNextListBindings: () => {
      failNextListBindings = true;
    },
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 2);
  }),
);

it.effect("does not let an admitted turn rewrite the stopped binding after shutdown", () => {
  const codex = makeFakeCodexAdapter();
  // Keep the native session alive in this test so the admitted turn can finish
  // after the service finalizer commits its stopped binding.
  codex.stopAll.mockImplementation(() => Effect.void);
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const directory = makeFailingProviderSessionDirectory();
  const directoryLayer = Layer.succeed(
    ProviderSessionDirectory.ProviderSessionDirectory,
    directory.directory,
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const testLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);

  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(testLayer).pipe(Scope.provide(scope));
    const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const threadId = asThreadId("thread-shutdown-write-fence");
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
    });

    const sendEntered = yield* Deferred.make<void>();
    const releaseSend = yield* Deferred.make<void>();
    codex.setSendGate(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(sendEntered, undefined);
        yield* Deferred.await(releaseSend);
      }),
    );
    const send = yield* provider
      .sendTurn({ threadId, input: "finish after shutdown", attachments: [] })
      .pipe(Effect.forkDetach);
    yield* Deferred.await(sendEntered);

    const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("10001 millis");
    yield* Effect.yieldNow;
    yield* Fiber.join(close);

    const stoppedBinding = Option.getOrUndefined(yield* directory.directory.getBinding(threadId));
    assert.equal(stoppedBinding?.status, "stopped");

    yield* Deferred.succeed(releaseSend, undefined);
    const sendExit = yield* Fiber.join(send).pipe(Effect.exit);
    assert.equal(Exit.isFailure(sendExit), true);
    const finalBinding = Option.getOrUndefined(yield* directory.directory.getBinding(threadId));
    assert.equal(finalBinding?.status, "stopped");
    codex.setSendGate(undefined);
  }).pipe(Effect.provide(NodeServices.layer));
});

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("cleans up a native session when its routing binding cannot be persisted", () => {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
  });
  const failingDirectory = makeFailingProviderSessionDirectory();
  const directoryLayer = Layer.succeed(
    ProviderSessionDirectory.ProviderSessionDirectory,
    failingDirectory.directory,
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const testLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);

  return Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const threadId = asThreadId("thread-binding-write-failure");

    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
    });
    failingDirectory.failNextUpsert();

    const failed = yield* Effect.exit(
      provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      }),
    );
    assert.equal(Exit.isFailure(failed), true);
    assert.equal(yield* codex.hasSession(threadId), true);
    assert.equal(yield* claude.hasSession(threadId), false);
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    assert.equal(binding?.provider, CODEX_DRIVER);
    assert.equal(binding?.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(testLayer));
});

it.effect("retries routing initialization after an unavailable binding snapshot", () => {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const failingDirectory = makeFailingProviderSessionDirectory();
  failingDirectory.failNextListBindings();
  const directoryLayer = Layer.succeed(
    ProviderSessionDirectory.ProviderSessionDirectory,
    failingDirectory.directory,
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const testLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);

  return Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const threadId = asThreadId("thread-routing-init-retry");
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
    });

    const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
      Ref.update(received, (current) => [...current, event]),
    ).pipe(Effect.forkChild);
    yield* advanceTestClock(50);
    codex.emit({
      type: "turn.completed",
      eventId: asEventId("evt-routing-init-retry"),
      provider: CODEX_DRIVER,
      createdAt: "2026-01-01T00:00:00.001Z",
      threadId,
      turnId: asTurnId("turn-routing-init-retry"),
      status: "completed",
    });
    yield* advanceTestClock(50);
    yield* Fiber.interrupt(consumer);
    assert.deepEqual(
      (yield* Ref.get(received)).map((event) => event.eventId),
      [asEventId("evt-routing-init-retry")],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect("restores a same-instance native session after binding persistence fails", () => {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
  });
  const failingDirectory = makeFailingProviderSessionDirectory();
  const directoryLayer = Layer.succeed(
    ProviderSessionDirectory.ProviderSessionDirectory,
    failingDirectory.directory,
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const testLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);

  return Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const threadId = asThreadId("thread-same-instance-binding-failure");

    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      cwd: "/tmp/project-same-instance-rollback",
      runtimeMode: "full-access",
    });
    failingDirectory.failNextUpsert();

    const failed = yield* Effect.exit(
      provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-same-instance-rollback-next",
        runtimeMode: "full-access",
      }),
    );
    assert.equal(Exit.isFailure(failed), true);
    assert.equal(yield* codex.hasSession(threadId), true);
    assert.equal(codex.startSession.mock.calls.length, 3);
    const restoredInput = codex.startSession.mock.calls[2]?.[0];
    assert.equal(restoredInput?.cwd, "/tmp/project-same-instance-rollback");
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    assert.equal(binding?.provider, CODEX_DRIVER);
    assert.equal(binding?.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rolls back a recovered session when its binding cannot be persisted", () => {
  const codex = makeFakeCodexAdapter();
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
  });
  const failingDirectory = makeFailingProviderSessionDirectory();
  const directoryLayer = Layer.succeed(
    ProviderSessionDirectory.ProviderSessionDirectory,
    failingDirectory.directory,
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(serverConfigTestLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
  const testLayer = Layer.mergeAll(providerLayer, directoryLayer, NodeServices.layer);

  return Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const threadId = asThreadId("thread-recovery-binding-failure");
    yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
    });
    yield* codex.stopAll();
    failingDirectory.failNextUpsert();

    const failed = yield* Effect.exit(
      provider.sendTurn({ threadId, input: "recover", attachments: [] }),
    );
    assert.equal(Exit.isFailure(failed), true);
    assert.equal(yield* codex.hasSession(threadId), false);
    const binding = Option.getOrUndefined(
      yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
    );
    assert.equal(binding?.provider, CODEX_DRIVER);
    assert.equal(binding?.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(testLayer));
});

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("appends attachment file paths to the turn input text", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-attach"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-attach"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const attachment = {
        type: "image" as const,
        id: "thread-attach-12345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 123,
      };

      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "use this screenshot",
        attachments: [attachment],
      });

      const turnInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(typeof turnInput.input, "string");
      const turnText = turnInput.input ?? "";
      assert.equal(turnText.startsWith("use this screenshot"), true);
      assert.include(turnText, '[Attached image "screenshot.png" is saved at: ');
      assert.equal(turnText.endsWith(`${attachment.id}.png]`), true);

      // An attachment-only turn stays valid and the injected line becomes the
      // whole input text, so the agent still learns the path.
      routing.codex.sendTurn.mockClear();
      yield* provider.sendTurn({
        threadId: session.threadId,
        attachments: [attachment],
      });
      const imageOnlyInput = routing.codex.sendTurn.mock.calls[0]?.[0] as ProviderSendTurnInput;
      assert.equal(imageOnlyInput.input?.startsWith('[Attached image "screenshot.png"'), true);

      yield* provider.stopSession({ threadId: session.threadId });
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("repairs a mid-restart binding before exposing or routing the live session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      // A same-thread provider switch briefly leaves the live session on the
      // new provider while the persisted binding still names the old one. The
      // list snapshot must repair the binding before a subsequent turn routes.
      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["codex"],
      );
      const repairedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(repairedBinding?.provider, CODEX_DRIVER);
      assert.equal(repairedBinding?.providerInstanceId, codexInstanceId);
      yield* provider.sendTurn({
        threadId,
        input: "route after repair",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.at(-1)?.[0]?.threadId, threadId);
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("serializes concurrent provider replacements for one thread", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-concurrent-provider-replacement");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const claudeStartsBefore = routing.claude.startSession.mock.calls.length;
      const codexStopsBefore = routing.codex.stopSession.mock.calls.length;
      routing.codex.setStartGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      );

      const first = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      const second = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(routing.claude.startSession.mock.calls.length, claudeStartsBefore);

      yield* Deferred.succeed(release, undefined);
      const firstSession = yield* Fiber.join(first);
      const secondSession = yield* Fiber.join(second);
      assert.equal(firstSession.provider, CODEX_DRIVER);
      assert.equal(secondSession.provider, CLAUDE_AGENT_DRIVER);
      assert.deepEqual(routing.codex.stopSession.mock.calls.slice(codexStopsBefore), [[threadId]]);

      const binding = yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(
        threadId,
      );
      assert.equal(Option.getOrUndefined(binding)?.provider, CLAUDE_AGENT_DRIVER);
    }).pipe(Effect.ensuring(Effect.sync(() => routing.codex.setStartGate(undefined)))),
  );

  it.effect("serializes a routed turn against a concurrent provider replacement", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-send-provider-replacement");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const claudeStartsBefore = routing.claude.startSession.mock.calls.length;
      routing.codex.setSendGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      );

      const send = yield* provider
        .sendTurn({ threadId, input: "hold the route", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      const replacement = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(routing.claude.startSession.mock.calls.length, claudeStartsBefore);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(send);
      const session = yield* Fiber.join(replacement);
      assert.equal(session.provider, CLAUDE_AGENT_DRIVER);
      const binding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(binding?.provider, CLAUDE_AGENT_DRIVER);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          routing.codex.setSendGate(undefined);
        }),
      ),
    ),
  );

  it.effect("keeps interrupt and approval controls responsive during a routed turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-routed-control");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      routing.codex.setSendGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      );

      const send = yield* provider
        .sendTurn({ threadId, input: "hold the prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      const interrupt = yield* provider
        .interruptTurn({ threadId, turnId: asTurnId("turn-control") })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const interruptExit = yield* Effect.sync(() => interrupt.pollUnsafe());
      assert.equal(interruptExit !== undefined, true);
      if (interruptExit !== undefined) assert.equal(Exit.isSuccess(interruptExit), true);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupt);
      yield* Fiber.join(send);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          routing.codex.setSendGate(undefined);
        }),
      ),
    ),
  );

  it.effect("rejects new routed controls once a stop transition begins", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-control-during-stop");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const stopEntered = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      routing.codex.setStopGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(stopEntered, undefined);
          yield* Deferred.await(releaseStop);
        }),
      );

      const stop = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopEntered);

      const controlExit = yield* provider
        .interruptTurn({ threadId, turnId: asTurnId("turn-stopping") })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(controlExit), true);
      if (Exit.isFailure(controlExit)) {
        const failure = controlExit.cause.reasons.find(Cause.isFailReason)?.error;
        assert.instanceOf(failure, ProviderValidationError);
      }

      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stop);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          routing.codex.setStopGate(undefined);
        }),
      ),
    ),
  );

  it.effect("bounds a provider stop that never acknowledges", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stop-timeout");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const stopEntered = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      routing.codex.setStopGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(stopEntered, undefined);
          yield* Deferred.await(releaseStop);
        }),
      );

      const stop = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopEntered);
      yield* TestClock.adjust("10001 millis");
      yield* Effect.yieldNow;

      const stopExit = yield* Fiber.join(stop).pipe(Effect.exit);
      assert.equal(Exit.isFailure(stopExit), true);
      yield* Deferred.succeed(releaseStop, undefined);
    }).pipe(Effect.ensuring(Effect.sync(() => routing.codex.setStopGate(undefined)))),
  );

  it.effect("keeps queued turns behind a timed-out stop until the active turn drains", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stop-timeout-active-turn");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const sendEntered = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      let sendGateCalls = 0;
      routing.codex.setSendGate(() => {
        sendGateCalls += 1;
        return sendGateCalls === 1
          ? Effect.gen(function* () {
              yield* Deferred.succeed(sendEntered, undefined);
              yield* Deferred.await(releaseSend);
            })
          : Effect.void;
      });

      const activeSend = yield* provider
        .sendTurn({ threadId, input: "active", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sendEntered);

      const stopExit = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10001 millis");
      const stopped = yield* Fiber.join(stopExit).pipe(Effect.exit);
      assert.equal(Exit.isFailure(stopped), true);

      const queuedSend = yield* provider
        .sendTurn({ threadId, input: "queued", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(sendGateCalls, 1);

      yield* Deferred.succeed(releaseSend, undefined);
      yield* Fiber.join(activeSend).pipe(Effect.exit);
      yield* Fiber.join(queuedSend).pipe(Effect.exit);
      assert.equal(sendGateCalls, 2);
    }).pipe(Effect.ensuring(Effect.sync(() => routing.codex.setSendGate(undefined)))),
  );

  it.effect("does not recover a stopped binding for a turn admitted during stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stop-queued-turn");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const stopEntered = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      routing.codex.setStopGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(stopEntered, undefined);
          yield* Deferred.await(releaseStop);
        }),
      );
      const stop = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(stopEntered);

      routing.codex.sendTurn.mockClear();
      const queuedTurn = yield* provider
        .sendTurn({ threadId, input: "must not revive", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stop);
      const turnExit = yield* Fiber.join(queuedTurn).pipe(Effect.exit);
      assert.equal(Exit.isFailure(turnExit), true);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(yield* routing.codex.hasSession(threadId), false);
      const binding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(binding?.status, "stopped");
    }).pipe(Effect.ensuring(Effect.sync(() => routing.codex.setStopGate(undefined)))),
  );

  it.effect("rolls back a replacement when stale-session cleanup fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stale-cleanup-failure");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "stopSession",
            detail: "simulated stale-session cleanup failure",
          }),
        ),
      );

      const replacementExit = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(replacementExit), true);

      assert.equal(yield* routing.codex.hasSession(threadId), true);
      assert.equal(yield* routing.claude.hasSession(threadId), false);
      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        [CODEX_DRIVER],
      );
      const binding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(binding?.provider, CODEX_DRIVER);
    }),
  );

  it.effect("reports replacement rollback failure when the target cannot be stopped", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-target-stop-failure");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: "stopSession",
            detail: "simulated stale-session cleanup failure",
          }),
        ),
      );
      routing.claude.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CLAUDE_AGENT_DRIVER),
            method: "stopSession",
            detail: "simulated replacement rollback failure",
          }),
        ),
      );

      const replacementExit = yield* provider
        .startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(replacementExit), true);
      assert.equal(yield* routing.codex.hasSession(threadId), true);
      assert.equal(yield* routing.claude.hasSession(threadId), true);
      const binding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(binding?.provider, CODEX_DRIVER);
    }),
  );

  it.effect("marks an explicit stop partial when stale cleanup still fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-partial-stop");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      // Simulate a stale native process left behind by a previous failed
      // replacement. It is intentionally not a durable owner.
      yield* routing.claude.startSession({
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.claude.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CLAUDE_AGENT_DRIVER),
            method: "stopSession",
            detail: "simulated stale cleanup failure",
          }),
        ),
      );

      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(received, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const stopExit = yield* provider.stopSession({ threadId }).pipe(Effect.exit);
      assert.equal(Exit.isFailure(stopExit), true);
      assert.equal(yield* routing.codex.hasSession(threadId), false);
      assert.equal(yield* routing.claude.hasSession(threadId), true);
      const binding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(binding?.status, "error");
      routing.claude.sendTurn.mockClear();
      const blockedTurn = yield* provider
        .sendTurn({ threadId, input: "must not route", attachments: [] })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(blockedTurn), true);
      assert.equal(routing.claude.sendTurn.mock.calls.length, 0);
      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-partial-stop-codex"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.001Z",
        threadId,
        turnId: asTurnId("turn-partial-stop"),
        status: "completed",
      });
      routing.claude.emit({
        type: "turn.completed",
        eventId: asEventId("evt-partial-stop-claude"),
        provider: CLAUDE_AGENT_DRIVER,
        createdAt: "2026-01-01T00:00:00.001Z",
        threadId,
        turnId: asTurnId("turn-partial-stop-stale"),
        status: "completed",
      });
      yield* advanceTestClock(50);
      yield* Fiber.interrupt(consumer);
      assert.deepEqual(yield* Ref.get(received), []);

      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const recoveredBinding = Option.getOrUndefined(
        yield* (yield* ProviderSessionDirectory.ProviderSessionDirectory).getBinding(threadId),
      );
      assert.equal(recoveredBinding?.status, "running");
      assert.equal(
        (recoveredBinding?.runtimePayload as { routingState?: unknown } | null | undefined)
          ?.routingState,
        null,
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(serverConfigTestLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("drops late events from a retired provider instance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-stale-provider-event");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(received, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-stale-provider"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId: asTurnId("turn-stale-provider"),
        status: "completed",
      });
      fanout.claude.emit({
        type: "turn.completed",
        eventId: asEventId("evt-current-provider"),
        provider: CLAUDE_AGENT_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId: asTurnId("turn-current-provider"),
        status: "completed",
      });
      yield* advanceTestClock(50);
      yield* Fiber.interrupt(consumer);

      const events = yield* Ref.get(received);
      assert.deepEqual(
        events.map((event) => event.eventId),
        [asEventId("evt-current-provider")],
      );
    }),
  );

  it.effect("drops a delayed same-instance session exit after restart", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-same-instance-restart");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(received, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      // The same configured instance is restarted, so the adapter identity and
      // providerInstanceId are intentionally unchanged.
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      fanout.codex.emit({
        type: "session.exited",
        eventId: asEventId("evt-same-instance-stale-exit"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        payload: { reason: "old context" },
      });
      yield* advanceTestClock(50);
      yield* Fiber.interrupt(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).filter(
          (event) => event.eventId === asEventId("evt-same-instance-stale-exit"),
        ),
        [],
      );
    }),
  );

  it.effect("drops queued same-instance output and request events after restart", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-same-instance-queued-events");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(received, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const staleEvents: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "session.started",
          eventId: asEventId("evt-same-instance-stale-lifecycle"),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          payload: { message: "old context restarted" },
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-same-instance-stale-turn"),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          turnId: asTurnId("turn-old-context"),
          status: "completed",
        },
        {
          type: "content.delta",
          eventId: asEventId("evt-same-instance-stale-content"),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          turnId: asTurnId("turn-old-context"),
          delta: "old output",
        },
        {
          type: "request.opened",
          eventId: asEventId("evt-same-instance-stale-request"),
          provider: CODEX_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          requestId: asRequestId("request-old-context"),
          requestType: "command_execution_approval",
          title: "old request",
        },
      ];
      for (const event of staleEvents) fanout.codex.emit(event);
      yield* advanceTestClock(50);
      yield* Fiber.interrupt(consumer);

      const receivedIds = new Set((yield* Ref.get(received)).map((event) => event.eventId));
      for (const event of staleEvents) {
        assert.equal(receivedIds.has(event.eventId), false);
      }
    }),
  );

  it.effect("drops retired-provider events during a pending replacement", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-pending-provider-event");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const received = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(received, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const replacementStarted = yield* Deferred.make<void>();
      const releaseReplacement = yield* Deferred.make<void>();
      fanout.codex.setStartGate(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(replacementStarted, undefined);
          yield* Deferred.await(releaseReplacement);
        }),
      );

      const replacement = yield* provider
        .startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(replacementStarted).pipe(Effect.timeout(2_000), Effect.orDie);

      fanout.claude.emit({
        type: "turn.completed",
        eventId: asEventId("evt-pending-stale-provider"),
        provider: CLAUDE_AGENT_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId: asTurnId("turn-pending-stale-provider"),
        status: "completed",
      });
      yield* advanceTestClock(50);
      assert.deepEqual(yield* Ref.get(received), []);

      yield* Deferred.succeed(releaseReplacement, undefined);
      yield* Fiber.join(replacement);
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-pending-current-provider"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId,
        turnId: asTurnId("turn-pending-current-provider"),
        status: "completed",
      });
      yield* advanceTestClock(50);
      yield* Fiber.interrupt(consumer);

      assert.deepEqual(
        (yield* Ref.get(received)).map((event) => event.eventId),
        [asEventId("evt-pending-current-provider")],
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          fanout.codex.setStartGate(undefined);
        }),
      ),
    ),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.001Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.001Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.001Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
