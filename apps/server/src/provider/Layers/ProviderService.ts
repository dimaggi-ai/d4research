/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@d4research/contracts";
import { causeErrorTag } from "@d4research/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
const isModelSelection = Schema.is(ModelSelection);
const PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS = 10_000;

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Bound provider cleanup calls without widening every service method with
 * Effect's generic TimeoutError. A timeout is a provider-service failure, not
 * an invalid caller payload, but ProviderValidationError is the established
 * typed service-level error for failures before a provider result exists.
 */
const withProviderShutdownTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operation: string,
): Effect.Effect<A, E | ProviderValidationError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS,
      orElse: () =>
        Effect.fail(
          toValidationError(
            operation,
            `Operation timed out after ${PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS}ms.`,
          ),
        ),
    }),
  );

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly sessionGenerationAt?: string;
    readonly sessionRestartGenerationAt?: string | null;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    // A newly adopted/started native session leaves any previous partial-stop
    // marker behind only if this field is omitted; make the recovery boundary
    // explicit for the persistence layer's merge semantics.
    routingState: null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.sessionGenerationAt !== undefined
      ? { sessionGenerationAt: extra.sessionGenerationAt }
      : {}),
    ...(extra?.sessionRestartGenerationAt !== undefined
      ? { sessionRestartGenerationAt: extra.sessionRestartGenerationAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedSessionRestartGenerationAt(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const value =
    "sessionRestartGenerationAt" in runtimePayload
      ? runtimePayload.sessionRestartGenerationAt
      : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRuntimePayloadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayloadForRouting(
  existing: unknown | null | undefined,
  next: unknown | null | undefined,
): unknown | null | undefined {
  if (next === undefined) return existing;
  if (isRuntimePayloadRecord(existing) && isRuntimePayloadRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

function isPartiallyStoppedBinding(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): boolean {
  if (
    binding.status !== "error" ||
    !binding.runtimePayload ||
    typeof binding.runtimePayload !== "object"
  ) {
    return false;
  }
  const payload = binding.runtimePayload as Record<string, unknown>;
  return payload.routingState === "partial-stop";
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  type PendingRuntimeOwner = {
    readonly providerInstanceId: ProviderInstanceId;
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  };
  type RuntimeRestartFence = PendingRuntimeOwner & {
    /** Session timestamp returned by the replacement start. */
    readonly generationAt?: string;
  };
  type RuntimeRoutingState = {
    /**
     * The event gate reads this snapshot instead of querying persistence for
     * every event. All service-owned binding writes update it only after the
     * durable write succeeds.
     */
    readonly bindings: ReadonlyMap<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>;
    /** A failed initial directory read is not equivalent to an empty directory. */
    readonly initialized: boolean;
    /** The owner being started while its durable binding is still old. */
    readonly pending: ReadonlyMap<ThreadId, PendingRuntimeOwner>;
    /** Same-instance restarts must observe the new session lifecycle before
     * ordinary queued events can be accepted again. */
    readonly restartFences: ReadonlyMap<ThreadId, RuntimeRestartFence>;
    /** Adapter identity is a subscription generation fence. */
    readonly adapters: ReadonlyMap<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>;
  };
  const runtimeRoutingStateRef = yield* SynchronizedRef.make<RuntimeRoutingState>({
    bindings: new Map(),
    initialized: false,
    pending: new Map(),
    restartFences: new Map(),
    adapters: new Map(),
  });
  const initialBindingsExit = yield* Effect.exit(directory.listBindings());
  if (Exit.isSuccess(initialBindingsExit)) {
    yield* SynchronizedRef.update(runtimeRoutingStateRef, (current) => ({
      ...current,
      initialized: true,
      bindings: new Map(
        initialBindingsExit.value.map((binding) => [binding.threadId, binding] as const),
      ),
    }));
  } else {
    yield* Effect.logWarning("ProviderService: failed to load initial routing bindings", {
      cause: causeErrorTag(initialBindingsExit.cause),
    });
  }
  type ServiceActivityState = {
    readonly closing: boolean;
    readonly active: number;
    readonly changed: Deferred.Deferred<void>;
    readonly activeFibers: ReadonlyMap<number, Fiber.Fiber<unknown, unknown>>;
  };
  const serviceActivityRef = yield* SynchronizedRef.make<ServiceActivityState>({
    closing: false,
    active: 0,
    changed: yield* Deferred.make<void>(),
    activeFibers: new Map(),
  });
  const withServiceActivity = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    // Admission (active + 1, fiber registration) commits uninterruptibly and the
    // decrement finalizer is armed before `effect` becomes cancellable again, so
    // an interrupt cannot leak `active` or a stale `activeFibers` entry and stall
    // shutdown's drain on a fiber that has already completed.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const currentFiber = Fiber.getCurrent();
        yield* SynchronizedRef.modifyEffect(serviceActivityRef, (current) =>
          current.closing
            ? Effect.fail(
                toValidationError(
                  "ProviderService",
                  "Provider service is shutting down and no longer accepts new operations.",
                ),
              )
            : Deferred.succeed(current.changed, undefined).pipe(
                Effect.andThen(Deferred.make<void>()),
                Effect.map((changed) => {
                  const activeFibers = new Map(current.activeFibers);
                  if (currentFiber) activeFibers.set(currentFiber.id, currentFiber);
                  return [
                    true,
                    { ...current, active: current.active + 1, changed, activeFibers },
                  ] as const;
                }),
              ),
        ) as Effect.Effect<true, ProviderValidationError>;
        return yield* restore(effect).pipe(
          Effect.ensuring(
            SynchronizedRef.modifyEffect(serviceActivityRef, (current) =>
              Deferred.succeed(current.changed, undefined).pipe(
                Effect.andThen(Deferred.make<void>()),
                Effect.map((changed) => {
                  const activeFibers = new Map(current.activeFibers);
                  if (currentFiber) activeFibers.delete(currentFiber.id);
                  return [
                    undefined,
                    { ...current, active: Math.max(0, current.active - 1), changed, activeFibers },
                  ] as const;
                }),
              ),
            ).pipe(Effect.asVoid),
          ),
        );
      }),
    );
  const beginShutdown = SynchronizedRef.modifyEffect(serviceActivityRef, (current) =>
    current.closing
      ? Effect.succeed([false, current] as const)
      : Deferred.succeed(current.changed, undefined).pipe(
          Effect.andThen(Deferred.make<void>()),
          Effect.map((changed) => [true, { ...current, closing: true, changed }] as const),
        ),
  );
  const awaitServiceActivityIdle = Effect.gen(function* () {
    while (true) {
      const snapshot = yield* SynchronizedRef.get(serviceActivityRef);
      if (snapshot.active === 0) return;
      yield* Deferred.await(snapshot.changed);
    }
  });
  const interruptActiveServiceFibers = SynchronizedRef.get(serviceActivityRef).pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        [...snapshot.activeFibers.values()],
        (fiber) => Fiber.interrupt(fiber).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );
  const ensureRoutingInitialized = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(runtimeRoutingStateRef);
    if (current.initialized) return true;
    const bindingsExit = yield* Effect.exit(directory.listBindings());
    if (Exit.isFailure(bindingsExit)) {
      yield* Effect.logWarning("ProviderService: routing bindings are still unavailable", {
        cause: causeErrorTag(bindingsExit.cause),
      });
      return false;
    }
    yield* SynchronizedRef.update(runtimeRoutingStateRef, (state) => {
      const bindings = new Map(state.bindings);
      for (const binding of bindingsExit.value) bindings.set(binding.threadId, binding);
      return { ...state, initialized: true, bindings };
    });
    return true;
  });
  const runtimeBindingWriteSemaphore = yield* Semaphore.make(1);
  const mcpCredentialTransitionSemaphore = yield* Semaphore.make(1);

  const ensureServiceOpen = Effect.gen(function* () {
    const activity = yield* SynchronizedRef.get(serviceActivityRef);
    if (activity.closing) {
      return yield* toValidationError(
        "ProviderService",
        "Provider service is shutting down and no longer accepts new operations.",
      );
    }
  });
  const prepareMcpSession = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    options?: { readonly preserveExisting?: boolean },
  ) =>
    mcpCredentialTransitionSemaphore.withPermit(
      Effect.gen(function* () {
        yield* ensureServiceOpen;
        const credential = yield* options?.preserveExisting
          ? McpSessionRegistry.issueActiveMcpCredentialPreserving({ threadId, providerInstanceId })
          : McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId });
        if (credential) {
          yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
        }
        return credential;
      }),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    mcpCredentialTransitionSemaphore.withPermit(
      McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
        Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      ),
    );
  const restoreMcpSession = (
    threadId: ThreadId,
    previous: McpProviderSession.McpProviderSessionConfig | undefined,
  ) =>
    mcpCredentialTransitionSemaphore.withPermit(
      Effect.gen(function* () {
        // A failed replacement may have issued more than one credential before
        // reaching this compensation path. Keep only the credential belonging to
        // the restored provider, then put its routing slot back in place.
        yield* McpSessionRegistry.revokeActiveMcpThreadExcept(
          threadId,
          previous?.providerSessionId,
        );
        if (previous) {
          yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(previous));
        } else {
          yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
        }
      }),
    );
  const revokeAllMcpCredentialsDuringShutdown = mcpCredentialTransitionSemaphore.withPermit(
    McpSessionRegistry.revokeAllActiveMcpCredentials().pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
    ),
  );

  // A provider switch is a multi-side-effect transition (native start,
  // routing binding, MCP credential, stale-session cleanup). Serialize those
  // transitions per thread so two browser tabs cannot stop each other's newly
  // started session or restore an obsolete binding during compensation. Turns
  // and control responses use a shared routed-operation gate: a long-running
  // ACP prompt must remain interruptible/respondable while a replacement waits
  // for it to drain. The reference count lets idle entries leave the map;
  // thread ids are user data and must not pin an unbounded number of semaphores
  // for the service lifetime.
  type ThreadGateMode = "idle" | "exclusive" | "stopping" | "draining";
  type ThreadGateState = {
    readonly mode: ThreadGateMode;
    readonly activeTurns: number;
    readonly activeControls: number;
    readonly changed: Deferred.Deferred<void>;
  };
  type ThreadGateDecision = {
    readonly acquired: boolean;
    readonly wait: Deferred.Deferred<void> | undefined;
  };
  type ThreadTransitionLockEntry = {
    readonly semaphore: Semaphore.Semaphore;
    readonly state: SynchronizedRef.SynchronizedRef<ThreadGateState>;
    readonly users: number;
  };
  const threadTransitionLocksRef = yield* SynchronizedRef.make(
    new Map<string, ThreadTransitionLockEntry>(),
  );
  const getThreadTransitionLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadTransitionLocksRef, (current) => {
      const key = String(threadId);
      const existing = current.get(key);
      if (existing) {
        const next = new Map(current);
        next.set(key, { ...existing, users: existing.users + 1 });
        return Effect.succeed([existing, next] as const);
      }
      return Effect.all({ semaphore: Semaphore.make(1), changed: Deferred.make<void>() }).pipe(
        Effect.flatMap(({ semaphore, changed }) =>
          SynchronizedRef.make<ThreadGateState>({
            mode: "idle",
            activeTurns: 0,
            activeControls: 0,
            changed,
          }).pipe(
            Effect.map((state) => {
              const next = new Map(current);
              const entry = { semaphore, state, users: 1 } satisfies ThreadTransitionLockEntry;
              next.set(key, entry);
              return [entry, next] as const;
            }),
          ),
        ),
      );
    });
  const releaseThreadTransitionLock = (threadId: ThreadId, entry: ThreadTransitionLockEntry) =>
    SynchronizedRef.update(threadTransitionLocksRef, (current) => {
      const key = String(threadId);
      const currentEntry = current.get(key);
      // A new entry may have been created after this one became idle. Do not
      // decrement or delete the newer entry in that case.
      if (currentEntry?.semaphore !== entry.semaphore) return current;
      const next = new Map(current);
      if (currentEntry.users <= 1) {
        next.delete(key);
      } else {
        next.set(key, { ...currentEntry, users: currentEntry.users - 1 });
      }
      return next;
    });
  const signalGateState = (
    current: ThreadGateState,
    next: Omit<ThreadGateState, "changed">,
    result: ThreadGateDecision,
  ): Effect.Effect<readonly [ThreadGateDecision, ThreadGateState]> =>
    Deferred.succeed(current.changed, undefined).pipe(
      Effect.andThen(Deferred.make<void>()),
      Effect.map((changed) => [result, { ...next, changed }] as const),
    );

  // Gate acquisition must run inside an `uninterruptibleMask` supplied by the
  // caller: the successful `modifyEffect` commit and the caller's finalizer
  // arming cannot be split by an interrupt. Only the blocking wait is `restore`d,
  // so a queued turn/transition stays cancellable while it waits for the gate.
  type RestoreInterruptibility = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  const acquireExclusiveGate = (
    entry: ThreadTransitionLockEntry,
    restore: RestoreInterruptibility,
  ) =>
    Effect.gen(function* () {
      let waited = false;
      while (true) {
        const decision = yield* SynchronizedRef.modifyEffect(entry.state, (current) =>
          current.mode !== "idle" || current.activeTurns > 0 || current.activeControls > 0
            ? Effect.succeed([
                { acquired: false as const, wait: current.changed },
                current,
              ] as const)
            : signalGateState(
                current,
                { mode: "exclusive", activeTurns: 0, activeControls: 0 },
                { acquired: true, wait: undefined },
              ),
        );
        if (decision.acquired) return waited;
        waited = true;
        yield* restore(Deferred.await(decision.wait!));
      }
    });

  const acquireStoppingGate = (
    entry: ThreadTransitionLockEntry,
    restore: RestoreInterruptibility,
  ) =>
    Effect.gen(function* () {
      while (true) {
        const decision = yield* SynchronizedRef.modifyEffect(entry.state, (current) =>
          current.mode !== "idle"
            ? Effect.succeed([
                { acquired: false as const, wait: current.changed },
                current,
              ] as const)
            : signalGateState(
                current,
                {
                  mode: "stopping",
                  activeTurns: current.activeTurns,
                  activeControls: current.activeControls,
                },
                { acquired: true, wait: undefined },
              ),
        );
        if (decision.acquired) return;
        yield* restore(Deferred.await(decision.wait!));
      }
    });

  const acquireTurnGate = (entry: ThreadTransitionLockEntry, restore: RestoreInterruptibility) =>
    Effect.gen(function* () {
      let waited = false;
      while (true) {
        const decision = yield* SynchronizedRef.modifyEffect(entry.state, (current) =>
          current.mode !== "idle"
            ? Effect.succeed([
                { acquired: false as const, wait: current.changed },
                current,
              ] as const)
            : signalGateState(
                current,
                {
                  mode: "idle",
                  activeTurns: current.activeTurns + 1,
                  activeControls: current.activeControls,
                },
                { acquired: true, wait: undefined },
              ),
        );
        if (decision.acquired) return waited;
        waited = true;
        yield* restore(Deferred.await(decision.wait!));
      }
    });

  const acquireControlGate = (entry: ThreadTransitionLockEntry, restore: RestoreInterruptibility) =>
    Effect.gen(function* () {
      while (true) {
        const decision = yield* SynchronizedRef.modifyEffect(entry.state, (current) =>
          current.mode === "exclusive"
            ? Effect.succeed([
                { acquired: false as const, wait: current.changed },
                current,
              ] as const)
            : current.mode === "stopping" || current.mode === "draining"
              ? Effect.fail(
                  toValidationError(
                    "ProviderService.control",
                    "Provider session is stopping and no longer accepts control requests.",
                  ),
                )
              : signalGateState(
                  current,
                  {
                    mode: current.mode,
                    activeTurns: current.activeTurns,
                    activeControls: current.activeControls + 1,
                  },
                  { acquired: true, wait: undefined },
                ),
        );
        if (decision.acquired) return;
        yield* restore(Deferred.await(decision.wait!));
      }
    });

  const releaseTurnGate = (entry: ThreadTransitionLockEntry) =>
    SynchronizedRef.modifyEffect(entry.state, (current) =>
      signalGateState(
        current,
        {
          mode:
            current.mode === "draining" &&
            Math.max(0, current.activeTurns - 1) === 0 &&
            current.activeControls === 0
              ? "idle"
              : current.mode,
          activeTurns: Math.max(0, current.activeTurns - 1),
          activeControls: current.activeControls,
        },
        { acquired: true, wait: undefined },
      ),
    ).pipe(Effect.asVoid);

  const releaseControlGate = (entry: ThreadTransitionLockEntry) =>
    SynchronizedRef.modifyEffect(entry.state, (current) =>
      signalGateState(
        current,
        {
          mode:
            current.mode === "draining" &&
            current.activeTurns === 0 &&
            Math.max(0, current.activeControls - 1) === 0
              ? "idle"
              : current.mode,
          activeTurns: current.activeTurns,
          activeControls: Math.max(0, current.activeControls - 1),
        },
        { acquired: true, wait: undefined },
      ),
    ).pipe(Effect.asVoid);

  const releaseTransitionGate = (entry: ThreadTransitionLockEntry) =>
    SynchronizedRef.modifyEffect(entry.state, (current) =>
      signalGateState(
        current,
        {
          mode:
            (current.mode === "stopping" || current.mode === "draining") &&
            (current.activeTurns > 0 || current.activeControls > 0)
              ? "draining"
              : "idle",
          activeTurns: current.activeTurns,
          activeControls: current.activeControls,
        },
        { acquired: true, wait: undefined },
      ),
    ).pipe(Effect.asVoid);

  const awaitRoutedOperations = (entry: ThreadTransitionLockEntry) =>
    Effect.gen(function* () {
      while (true) {
        const snapshot = yield* SynchronizedRef.get(entry.state);
        if (snapshot.activeTurns === 0 && snapshot.activeControls === 0) return;
        yield* Deferred.await(snapshot.changed);
      }
    });

  const withThreadTransitionLockUnsafe = <A, E, R>(
    threadId: ThreadId,
    effect: (waitedForGate: boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(getThreadTransitionLock(threadId), (entry) =>
        restore(
          entry.semaphore.withPermit(
            Effect.uninterruptibleMask((restoreGate) =>
              Effect.gen(function* () {
                const waitedForGate = yield* acquireExclusiveGate(entry, restoreGate);
                return yield* restoreGate(effect(waitedForGate)).pipe(
                  Effect.ensuring(releaseTransitionGate(entry)),
                );
              }),
            ),
          ),
        ).pipe(Effect.ensuring(releaseThreadTransitionLock(threadId, entry))),
      ),
    );

  const withThreadTransitionLock = <A, E, R>(
    threadId: ThreadId,
    effect: (waitedForGate: boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    withServiceActivity(withThreadTransitionLockUnsafe(threadId, effect));

  // A runtime event only needs to be fenced against durable transition commits
  // (start/stop/replacement), which each hold `entry.semaphore` across their
  // whole commit. Taking the same per-thread permit is sufficient: an event's
  // ownership read + publish cannot straddle a transition. It deliberately does
  // NOT take the exclusive gate. Events must not wait on in-flight turns or
  // controls — a turn's binding write keeps provider/instance stable and can
  // never flip the ownership decision — and events must not set `exclusive`
  // mode, which previously serialized every co-tenant thread's event stream
  // behind any active turn on the same instance. `withServiceActivity` is kept
  // so shutdown still rejects and drains in-flight event processing.
  //
  // Two narrow recovery-race windows are knowingly accepted here (the old
  // exclusive gate masked them only by making every event wait on
  // `activeTurns == 0`, which is exactly the head-of-line stall we removed):
  //   (A) A `sendTurn` that recovers a missing native session writes the new
  //       restart generation from inside `withRoutedTurn` (no `entry.semaphore`),
  //       so an event read that lands before that commit can publish a stale
  //       pre-generation event that a post-commit read would have dropped.
  //   (B) `restoreNativeSessions` re-arms a fence generation without the
  //       semaphore, and the disarm below matches on `adapter` alone, so a
  //       concurrent re-arm can be disarmed against the wrong generation.
  // Both need a recovery interleaving that is rare and low-severity (at worst a
  // single stale event reaches the stream; no data loss, deadlock, or security
  // impact). The clean writer-side fix — making recovery hold `entry.semaphore`
  // — deadlocks against a transition that holds the permit across its
  // `activeTurns == 0` wait while the recovering turn keeps `activeTurns` high.
  // See docs/internals/providers.md "Per-thread gate and the event fence".
  const withThreadEventFenceUnsafe = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(getThreadTransitionLock(threadId), (entry) =>
        restore(entry.semaphore.withPermit(effect)).pipe(
          Effect.ensuring(releaseThreadTransitionLock(threadId, entry)),
        ),
      ),
    );

  const withThreadEventFence = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    withServiceActivity(withThreadEventFenceUnsafe(threadId, effect));

  const withRoutedTurnUnsafe = <A, E, R>(
    threadId: ThreadId,
    effect: (waitedForGate: boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    // Arm every compensating release atomically with its acquisition. The gate
    // wait and the routed work stay cancellable via `restore`, but an interrupt
    // can never land between committing `activeTurns + 1` and arming
    // `releaseTurnGate`, which would otherwise wedge the gate out of idle
    // forever. Mirrors the acquire/commit discipline in persistRuntimeBinding.
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(getThreadTransitionLock(threadId), (entry) =>
        acquireTurnGate(entry, restore).pipe(
          Effect.flatMap((waitedForGate) =>
            restore(effect(waitedForGate)).pipe(Effect.ensuring(releaseTurnGate(entry))),
          ),
          Effect.ensuring(releaseThreadTransitionLock(threadId, entry)),
        ),
      ),
    );

  const withRoutedTurn = <A, E, R>(
    threadId: ThreadId,
    effect: (waitedForGate: boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    withServiceActivity(withRoutedTurnUnsafe(threadId, effect));

  const withRoutedControlUnsafe = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(getThreadTransitionLock(threadId), (entry) =>
        acquireControlGate(entry, restore).pipe(
          Effect.andThen(restore(effect).pipe(Effect.ensuring(releaseControlGate(entry)))),
          Effect.ensuring(releaseThreadTransitionLock(threadId, entry)),
        ),
      ),
    );

  const withRoutedControl = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    withServiceActivity(withRoutedControlUnsafe(threadId, effect));

  const withStoppingTransitionUnsafe = <A, E, R>(
    threadId: ThreadId,
    effect: (entry: ThreadTransitionLockEntry) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(getThreadTransitionLock(threadId), (entry) =>
        restore(
          entry.semaphore.withPermit(
            Effect.uninterruptibleMask((restoreGate) =>
              Effect.gen(function* () {
                yield* acquireStoppingGate(entry, restoreGate);
                return yield* restoreGate(effect(entry)).pipe(
                  Effect.ensuring(releaseTransitionGate(entry)),
                );
              }),
            ),
          ),
        ).pipe(Effect.ensuring(releaseThreadTransitionLock(threadId, entry))),
      ),
    );

  const withStoppingTransition = <A, E, R>(
    threadId: ThreadId,
    effect: (entry: ThreadTransitionLockEntry) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderValidationError, R> =>
    withServiceActivity(withStoppingTransitionUnsafe(threadId, effect));

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const rememberRuntimeBinding = (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
    SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
      const bindings = new Map(current.bindings);
      bindings.set(binding.threadId, binding);
      return { ...current, bindings };
    });
  const persistRuntimeBinding = (
    binding: ProviderSessionDirectory.ProviderRuntimeBinding,
    options?: { readonly allowDuringShutdown?: boolean },
  ) =>
    runtimeBindingWriteSemaphore.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!options?.allowDuringShutdown) {
            yield* ensureServiceOpen;
          }
          const current = yield* SynchronizedRef.get(runtimeRoutingStateRef);
          const currentBinding = current.bindings.get(binding.threadId);
          const effectiveBinding =
            currentBinding !== undefined
              ? {
                  ...binding,
                  ...(binding.runtimePayload !== undefined ||
                  currentBinding.runtimePayload !== undefined
                    ? {
                        runtimePayload: mergeRuntimePayloadForRouting(
                          currentBinding.runtimePayload,
                          binding.runtimePayload,
                        ),
                      }
                    : {}),
                }
              : binding;
          // Keep the database write interruptible, but once it has committed
          // make the routing snapshot update uncancellable. This prevents a
          // cancellation boundary between the durable write and the event
          // gate's in-memory owner check.
          yield* restore(directory.upsert(effectiveBinding));
          const activityAfterWrite = yield* SynchronizedRef.get(serviceActivityRef);
          if (activityAfterWrite.closing && !options?.allowDuringShutdown) {
            // An operation admitted before shutdown may have committed its
            // database write after the shutdown gate closed. Immediately turn
            // that late write into a stopped snapshot before releasing the
            // serialized write permit, so a finalizer cannot be followed by a
            // resurrected running binding.
            const stoppedBinding = {
              ...effectiveBinding,
              status: "stopped" as const,
              runtimePayload: {
                ...(isRuntimePayloadRecord(effectiveBinding.runtimePayload)
                  ? effectiveBinding.runtimePayload
                  : {}),
                activeTurnId: null,
                routingState: null,
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: yield* nowIso,
              },
            } satisfies ProviderSessionDirectory.ProviderRuntimeBinding;
            yield* restore(directory.upsert(stoppedBinding));
            yield* Effect.uninterruptible(rememberRuntimeBinding(stoppedBinding));
          } else {
            yield* Effect.uninterruptible(rememberRuntimeBinding(effectiveBinding));
          }
        }),
      ),
    );
  const replaceRuntimeBinding = (
    binding: ProviderSessionDirectory.ProviderRuntimeBinding,
    options?: { readonly allowDuringShutdown?: boolean },
  ) =>
    runtimeBindingWriteSemaphore.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!options?.allowDuringShutdown) {
            yield* ensureServiceOpen;
          }
          yield* restore(directory.replace(binding));
          const activityAfterWrite = yield* SynchronizedRef.get(serviceActivityRef);
          if (activityAfterWrite.closing && !options?.allowDuringShutdown) {
            const stoppedBinding = {
              ...binding,
              status: "stopped" as const,
              runtimePayload: {
                ...(isRuntimePayloadRecord(binding.runtimePayload) ? binding.runtimePayload : {}),
                activeTurnId: null,
                routingState: null,
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: yield* nowIso,
              },
            } satisfies ProviderSessionDirectory.ProviderRuntimeBinding;
            yield* restore(directory.replace(stoppedBinding));
            yield* Effect.uninterruptible(rememberRuntimeBinding(stoppedBinding));
          } else {
            yield* Effect.uninterruptible(rememberRuntimeBinding(binding));
          }
        }),
      ),
    );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly sessionGenerationAt?: string;
      readonly sessionRestartGenerationAt?: string | null;
      readonly allowDuringShutdown?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      const binding = {
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      } satisfies ProviderSessionDirectory.ProviderRuntimeBinding;
      yield* persistRuntimeBinding(
        binding,
        extra?.allowDuringShutdown === undefined
          ? undefined
          : { allowDuringShutdown: extra.allowDuringShutdown },
      );
    });

  const makeRecoveryStartInput = (
    binding: ProviderSessionDirectory.ProviderRuntimeBinding | undefined,
    liveSession: ProviderSession | undefined,
    threadId: ThreadId,
    provider: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
  ): ProviderSessionStartInput => {
    // A durable binding describes the committed owner only. When compensating
    // a failed switch, other live provider instances must be restored from
    // their own native session metadata rather than inheriting that owner’s
    // cwd, model, or resume cursor.
    const bindingMatchesSession =
      binding?.provider === provider && binding.providerInstanceId === providerInstanceId;
    const persistedPayload = bindingMatchesSession ? binding?.runtimePayload : undefined;
    const persistedCwd = readPersistedCwd(persistedPayload);
    const persistedModelSelection = readPersistedModelSelection(persistedPayload);
    const resumeCursor =
      (bindingMatchesSession ? binding?.resumeCursor : undefined) ?? liveSession?.resumeCursor;
    const cwd = persistedCwd ?? liveSession?.cwd;
    const runtimeMode =
      (bindingMatchesSession ? binding?.runtimeMode : undefined) ??
      liveSession?.runtimeMode ??
      "full-access";
    return {
      threadId,
      provider,
      providerInstanceId,
      ...(cwd ? { cwd } : {}),
      ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
      ...(resumeCursor !== undefined && resumeCursor !== null ? { resumeCursor } : {}),
      runtimeMode,
    };
  };

  /**
   * Compensate a partially completed provider transition. Starting a provider
   * can replace an existing same-instance process, while stale-session cleanup
   * can stop sessions on other instances. Re-checking each snapshot before
   * restarting it restores only sessions that really disappeared and avoids
   * creating duplicates when cleanup failed before stopping a process.
   */
  const restoreNativeSessions = (input: {
    readonly threadId: ThreadId;
    readonly targetAdapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly previousBinding: ProviderSessionDirectory.ProviderRuntimeBinding | undefined;
    readonly previousLiveSessions: ReadonlyArray<LiveProviderSession>;
    readonly previousMcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  }) =>
    Effect.gen(function* () {
      const isClosing = () =>
        SynchronizedRef.get(serviceActivityRef).pipe(Effect.map((state) => state.closing));

      // Compensation is best-effort during normal failures, but shutdown must
      // never resurrect a provider process or restore a bearer that the
      // finalizer has already revoked. The shutdown passes will retry native
      // cleanup after this admitted operation drains.
      if (yield* isClosing()) {
        yield* withProviderShutdownTimeout(
          input.targetAdapter.stopSession(input.threadId),
          "ProviderService.restoreNativeSessions.stopSession.duringShutdown",
        ).pipe(Effect.ignore);
        yield* clearMcpSession(input.threadId);
        return;
      }
      let compensationFailure: ProviderValidationError | undefined;
      const targetStopExit = yield* Effect.exit(
        withProviderShutdownTimeout(
          input.targetAdapter.stopSession(input.threadId),
          "ProviderService.restoreNativeSessions.stopSession",
        ),
      );
      const targetStillActive = yield* input.targetAdapter.hasSession(input.threadId).pipe(
        (effect) =>
          withProviderShutdownTimeout(effect, "ProviderService.restoreNativeSessions.hasSession"),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to verify provider after replacement failure", {
            threadId: input.threadId,
            provider: input.targetAdapter.provider,
            cause: causeErrorTag(cause),
          }).pipe(Effect.as(true)),
        ),
      );
      if (Exit.isFailure(targetStopExit) && targetStillActive) {
        yield* Effect.logWarning("failed to stop provider after replacement failure", {
          threadId: input.threadId,
          provider: input.targetAdapter.provider,
          cause: causeErrorTag(targetStopExit.cause),
        });
        compensationFailure ??= toValidationError(
          "ProviderService.restoreNativeSessions",
          `Provider '${input.targetAdapter.provider}' could not be stopped while restoring thread '${input.threadId}'.`,
        );
      }
      yield* restoreMcpSession(input.threadId, input.previousMcpSession);
      for (const live of input.previousLiveSessions) {
        if (yield* isClosing()) {
          yield* clearMcpSession(input.threadId);
          return;
        }
        const isActive = yield* live.adapter.hasSession(input.threadId).pipe(
          (effect) =>
            withProviderShutdownTimeout(
              effect,
              "ProviderService.restoreNativeSessions.previousHasSession",
            ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to inspect provider during replacement recovery", {
              threadId: input.threadId,
              provider: live.session.provider,
              cause: causeErrorTag(cause),
            }).pipe(Effect.as(true)),
          ),
        );
        if (isActive) continue;
        const restored = yield* live.adapter
          .startSession(
            makeRecoveryStartInput(
              input.previousBinding,
              live.session,
              input.threadId,
              live.session.provider,
              live.instanceId,
            ),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to restart previous provider session", {
                threadId: input.threadId,
                provider: live.session.provider,
                cause: causeErrorTag(cause),
              }).pipe(Effect.as(undefined)),
            ),
          );
        if (!restored) {
          compensationFailure ??= toValidationError(
            "ProviderService.restoreNativeSessions",
            `Previous provider '${live.session.provider}' could not be restarted for thread '${input.threadId}'.`,
          );
        }
        if (restored && restored.provider !== live.session.provider) {
          yield* Effect.logWarning("previous provider restart returned a mismatched driver", {
            threadId: input.threadId,
            expectedProvider: live.session.provider,
            receivedProvider: restored.provider,
          });
          compensationFailure ??= toValidationError(
            "ProviderService.restoreNativeSessions",
            `Previous provider restart returned '${restored.provider}' instead of '${live.session.provider}'.`,
          );
        }
        if (restored) {
          yield* armRestartFence(input.threadId, live.instanceId, live.adapter, restored.createdAt);
        }
      }
      if (yield* isClosing()) {
        yield* clearMcpSession(input.threadId);
      }
      if (targetStillActive) {
        compensationFailure = toValidationError(
          "ProviderService.restoreNativeSessions",
          `Provider '${input.targetAdapter.provider}' remained active while restoring thread '${input.threadId}'.`,
        );
      }
      if (compensationFailure) return yield* compensationFailure;
    });

  // Provider adapters can emit their started/ready events before startSession
  // has persisted the new routing binding. Remember the provisional owner in
  // the same routing snapshot as the binding and subscription maps. Event
  // validation below runs under the per-thread transition lock, so this state
  // is diagnostic and a final guard rather than a second, racy source of truth.
  const withPendingTransition = <A, E, R>(
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    effect: (
      adapter: ProviderAdapterShape<ProviderAdapterError>,
      isSameInstanceRestart: boolean,
    ) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderUnsupportedError, R> =>
    Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(providerInstanceId);
      const routingBeforeTransition = yield* SynchronizedRef.get(runtimeRoutingStateRef);
      const previousBinding = routingBeforeTransition.bindings.get(threadId);
      const isSameInstanceRestart =
        previousBinding !== undefined &&
        previousBinding.status !== "stopped" &&
        previousBinding?.providerInstanceId === providerInstanceId &&
        previousBinding.provider === adapter.provider;
      yield* SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
        const pending = new Map(current.pending);
        pending.set(threadId, { providerInstanceId, adapter });
        return { ...current, pending };
      });
      return yield* effect(adapter, isSameInstanceRestart).pipe(
        Effect.ensuring(
          SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
            const pending = new Map(current.pending);
            const pendingOwner = pending.get(threadId);
            if (
              pendingOwner?.providerInstanceId === providerInstanceId &&
              pendingOwner.adapter === adapter
            ) {
              pending.delete(threadId);
            }
            return { ...current, pending };
          }),
        ),
      );
    });

  const markRestartFence = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
      const restartFences = new Map(current.restartFences);
      restartFences.set(threadId, { providerInstanceId, adapter });
      return { ...current, restartFences };
    });

  const armRestartFence = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    generationAt: string,
  ) =>
    SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
      const fence = current.restartFences.get(threadId);
      if (fence?.providerInstanceId !== providerInstanceId || fence.adapter !== adapter) {
        return current;
      }
      const restartFences = new Map(current.restartFences);
      restartFences.set(threadId, { ...fence, generationAt });
      return { ...current, restartFences };
    });

  const clearRestartFence = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
      const fence = current.restartFences.get(threadId);
      if (fence?.providerInstanceId !== providerInstanceId || fence.adapter !== adapter) {
        return current;
      }
      const restartFences = new Map(current.restartFences);
      restartFences.delete(threadId);
      return { ...current, restartFences };
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderValidationError> =>
    Effect.gen(function* () {
      const canonicalEvent = yield* Effect.sync(() =>
        correlateRuntimeEventWithInstance(source, event),
      );
      // Serialize the ownership check with start/stop/replacement commits. A
      // DB lookup followed by independent refs allowed a transition to commit
      // between the reads, letting a stale event publish after the new binding
      // was durable. The lock also makes shutdown's stopped-state write a hard
      // boundary for already-buffered provider events.
      yield* withThreadEventFence(
        canonicalEvent.threadId,
        Effect.gen(function* () {
          const activity = yield* SynchronizedRef.get(serviceActivityRef);
          if (activity.closing) {
            yield* Effect.logWarning(
              "ProviderService.streamEvents: dropped event during shutdown",
              {
                threadId: canonicalEvent.threadId,
                eventType: canonicalEvent.type,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
              },
            );
            return;
          }
          const initialized = yield* ensureRoutingInitialized;
          const routing = yield* SynchronizedRef.get(runtimeRoutingStateRef);
          if (!initialized) {
            yield* Effect.logWarning(
              "ProviderService.streamEvents: dropped event before routing bindings initialized",
              {
                threadId: canonicalEvent.threadId,
                eventType: canonicalEvent.type,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
              },
            );
            return;
          }
          const binding = routing.bindings.get(canonicalEvent.threadId);
          const pendingOwner = routing.pending.get(canonicalEvent.threadId);
          const subscribedAdapter = routing.adapters.get(source.instanceId);
          const pendingInstance = pendingOwner?.providerInstanceId;
          const isCurrentOwner =
            binding === undefined ||
            (binding.status !== "stopped" &&
              !isPartiallyStoppedBinding(binding) &&
              binding.provider === canonicalEvent.provider &&
              binding.providerInstanceId === source.instanceId);
          const isPendingOwner =
            pendingOwner?.providerInstanceId === source.instanceId &&
            pendingOwner.adapter === source.adapter;
          if (
            subscribedAdapter !== source.adapter ||
            (pendingInstance !== undefined && !isPendingOwner) ||
            (!isCurrentOwner && !isPendingOwner)
          ) {
            // A stale provider process may still emit a late event after a
            // switch or failed stop. Drop it at the orchestration boundary
            // instead of allowing old output/turn state to overwrite the
            // committed owner.
            yield* Effect.logWarning("ProviderService.streamEvents: dropped stale provider event", {
              threadId: canonicalEvent.threadId,
              eventType: canonicalEvent.type,
              eventProvider: canonicalEvent.provider,
              eventProviderInstanceId: source.instanceId,
              bindingProvider: binding?.provider,
              bindingProviderInstanceId: binding?.providerInstanceId,
              pendingProviderInstanceId: pendingInstance,
              subscriptionCurrent: subscribedAdapter === source.adapter,
            });
            return;
          }
          const restartFence = routing.restartFences.get(canonicalEvent.threadId);
          const generationAt =
            restartFence?.generationAt ??
            readPersistedSessionRestartGenerationAt(binding?.runtimePayload);
          if (generationAt !== undefined && canonicalEvent.createdAt < generationAt) {
            yield* Effect.logWarning("ProviderService.streamEvents: dropped pre-generation event", {
              threadId: canonicalEvent.threadId,
              eventType: canonicalEvent.type,
              provider: canonicalEvent.provider,
              providerInstanceId: source.instanceId,
              generationAt,
              eventCreatedAt: canonicalEvent.createdAt,
            });
            return;
          }
          if (restartFence) {
            if (
              restartFence.providerInstanceId !== source.instanceId ||
              restartFence.adapter !== source.adapter
            ) {
              yield* Effect.logWarning("ProviderService.streamEvents: dropped fenced event", {
                threadId: canonicalEvent.threadId,
                eventType: canonicalEvent.type,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
              });
              return;
            }
            const isRestartLifecycleEvent =
              canonicalEvent.type === "session.started" ||
              canonicalEvent.type === "session.configured" ||
              // Codex never emits session.started/session.configured; it
              // announces a (re)started session's readiness via
              // session.state.changed(ready) (CodexSessionRuntime session/ready).
              // That ready signal comes only from the new session — a retired
              // session emits session.exited on teardown, never a second ready —
              // so it is a stale-safe restart boundary for every provider, not a
              // timestamp guess.
              (canonicalEvent.type === "session.state.changed" &&
                canonicalEvent.payload.state === "ready");
            if (!isRestartLifecycleEvent) {
              yield* Effect.logWarning("ProviderService.streamEvents: dropped pre-restart event", {
                threadId: canonicalEvent.threadId,
                eventType: canonicalEvent.type,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
              });
              return;
            }
            // A lifecycle event is accepted as the replacement boundary only
            // once startSession has returned its new session generation. A
            // queued event cannot disarm a fence while the replacement is
            // still unresolved.
            if (restartFence.generationAt === undefined) {
              yield* Effect.logWarning(
                "ProviderService.streamEvents: dropped unarmed restart lifecycle event",
                {
                  threadId: canonicalEvent.threadId,
                  eventType: canonicalEvent.type,
                  provider: canonicalEvent.provider,
                  providerInstanceId: source.instanceId,
                },
              );
              return;
            }
            yield* SynchronizedRef.update(runtimeRoutingStateRef, (current) => {
              const restartFences = new Map(current.restartFences);
              const currentFence = restartFences.get(canonicalEvent.threadId);
              if (currentFence?.adapter === source.adapter) {
                restartFences.delete(canonicalEvent.threadId);
              }
              return { ...current, restartFences };
            });
          }
          // A configured instance can be restarted without rebuilding its
          // adapter object. In that case a delayed exit notification from the
          // old context has the same providerInstanceId as the new session.
          // Adapters expose the closed context briefly (or remove it before
          // emitting), so an active context is a reliable local generation
          // fence for this destructive lifecycle event.
          if (canonicalEvent.type === "session.exited" && isCurrentOwner) {
            const liveSession = (yield* source.adapter.listSessions()).find(
              (session) => session.threadId === canonicalEvent.threadId,
            );
            if (liveSession && liveSession.status !== "closed") {
              yield* Effect.logWarning("ProviderService.streamEvents: dropped stale session exit", {
                threadId: canonicalEvent.threadId,
                provider: canonicalEvent.provider,
                providerInstanceId: source.instanceId,
              });
              return;
            }
          }
          if (canonicalEvent.type === "turn.started" && canonicalEvent.turnId !== undefined) {
            const activeMcpSession = McpProviderSession.readMcpProviderSession(
              canonicalEvent.threadId,
            );
            if (activeMcpSession) {
              yield* McpSessionRegistry.setActiveMcpTurn(
                activeMcpSession.providerSessionId,
                canonicalEvent.turnId,
              );
            }
          }
          yield* increment(providerRuntimeEventsTotal, {
            provider: canonicalEvent.provider,
            eventType: canonicalEvent.type,
          }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent)));
        }),
      );
    });

  // The adapter map in `runtimeRoutingStateRef` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const getAdapterEntries = SynchronizedRef.get(runtimeRoutingStateRef).pipe(
    Effect.map((state) => state.adapters),
    Effect.map((map) => Array.from(map.entries())),
  );

  type LiveProviderSession = {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly instanceId: ProviderInstanceId;
    readonly session: ProviderSession;
  };

  const findLiveSessionForThread = (threadId: ThreadId) =>
    getAdapterEntries.pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          ([instanceId, adapter]) =>
            adapter
              .listSessions()
              .pipe(
                Effect.map((sessions) =>
                  sessions
                    .filter((session) => session.threadId === threadId)
                    .map(
                      (session) => ({ adapter, instanceId, session }) satisfies LiveProviderSession,
                    ),
                ),
              ),
          { concurrency: 1 },
        ),
      ),
      Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)),
    );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* SynchronizedRef.get(runtimeRoutingStateRef).pipe(
      Effect.map((state) => state.adapters),
    );
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    const subscriptions: Array<
      readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]
    > = [];
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        subscriptions.push([id, adapter]);
      }
    }
    // Publish the identity map before starting subscriptions. Events from a
    // rebuilt adapter must be fenced as soon as the registry points at the
    // replacement, even if the old stream emits during startup teardown.
    yield* SynchronizedRef.update(runtimeRoutingStateRef, (current) => ({
      ...current,
      adapters: next,
    }));
    for (const [id, adapter] of subscriptions) {
      const consume = Effect.gen(function* () {
        while (true) {
          const current = yield* SynchronizedRef.get(runtimeRoutingStateRef);
          if (current.adapters.get(id) !== adapter) return;

          const attempt = yield* Effect.exit(
            Stream.runForEach(adapter.streamEvents, (event) =>
              processRuntimeEvent(
                {
                  instanceId: id,
                  provider: adapter.provider,
                  adapter,
                },
                event,
              ).pipe(
                // A malformed event or a downstream publish failure must not
                // tear down the adapter's entire subscription. Drop only
                // that event and keep consuming the provider stream.
                Effect.catchCause((cause) =>
                  Effect.logWarning("ProviderService.streamEvents: dropped malformed event", {
                    provider: adapter.provider,
                    providerInstanceId: id,
                    cause: causeErrorTag(cause),
                  }),
                ),
              ),
            ),
          );

          // Do not swallow scope interruption. `Effect.exit` is used only to
          // inspect transport failures; propagating this cause lets service
          // shutdown interrupt the subscriber instead of trapping it in the
          // retry loop.
          if (Exit.isFailure(attempt) && Cause.hasInterruptsOnly(attempt.cause)) {
            return yield* Effect.failCause(attempt.cause);
          }

          const latest = yield* SynchronizedRef.get(runtimeRoutingStateRef);
          if (latest.adapters.get(id) !== adapter) return;
          yield* Effect.logWarning("ProviderService.streamEvents: subscription stopped", {
            provider: adapter.provider,
            providerInstanceId: id,
            ...(Exit.isFailure(attempt) ? { cause: causeErrorTag(attempt.cause) } : {}),
          });
          yield* Effect.sleep("250 millis");
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ProviderService.streamEvents: subscription terminated", {
            provider: adapter.provider,
            providerInstanceId: id,
            cause: causeErrorTag(cause),
          }),
        ),
      );
      yield* consume.pipe(Effect.forkScoped);
    }
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          const staleSessionsStopped = yield* stopStaleSessionsForThread({
            threadId: input.binding.threadId,
            currentInstanceId: bindingInstanceId,
          });
          if (!staleSessionsStopped) {
            return yield* toValidationError(
              input.operation,
              `Cannot recover thread '${input.binding.threadId}' because a stale provider session could not be stopped.`,
            );
          }
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
            { sessionGenerationAt: existing.createdAt, sessionRestartGenerationAt: null },
          );
          const activeMcpSession = McpProviderSession.readMcpProviderSession(
            input.binding.threadId,
          );
          yield* McpSessionRegistry.revokeActiveMcpThreadExcept(
            input.binding.threadId,
            activeMcpSession?.providerSessionId,
          );
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      const previousMcpSession = McpProviderSession.readMcpProviderSession(input.binding.threadId);
      const previousLiveSessions = yield* findLiveSessionForThread(input.binding.threadId);

      const issuedMcpCredential = yield* prepareMcpSession(
        input.binding.threadId,
        bindingInstanceId,
        { preserveExisting: true },
      );
      const resumedExit = yield* Effect.exit(
        adapter.startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        }),
      );
      if (Exit.isFailure(resumedExit)) {
        yield* restoreNativeSessions({
          threadId: input.binding.threadId,
          targetAdapter: adapter,
          previousBinding: input.binding,
          previousLiveSessions,
          previousMcpSession,
        });
        return yield* Effect.failCause(resumedExit.cause);
      }
      const resumed = resumedExit.value;
      if (resumed.provider !== adapter.provider) {
        yield* restoreNativeSessions({
          threadId: input.binding.threadId,
          targetAdapter: adapter,
          previousBinding: input.binding,
          previousLiveSessions,
          previousMcpSession,
        });
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      const bindingExit = yield* Effect.exit(
        stopStaleSessionsForThread({
          threadId: input.binding.threadId,
          currentInstanceId: bindingInstanceId,
        }).pipe(
          Effect.flatMap((staleSessionsStopped) =>
            staleSessionsStopped
              ? upsertSessionBinding(
                  { ...resumed, providerInstanceId: bindingInstanceId },
                  input.binding.threadId,
                  {
                    sessionGenerationAt: resumed.createdAt,
                    sessionRestartGenerationAt: resumed.createdAt,
                  },
                )
              : Effect.fail(
                  toValidationError(
                    input.operation,
                    `Cannot recover thread '${input.binding.threadId}' because a stale provider session could not be stopped.`,
                  ),
                ),
          ),
        ),
      );
      if (Exit.isFailure(bindingExit)) {
        yield* restoreNativeSessions({
          threadId: input.binding.threadId,
          targetAdapter: adapter,
          previousBinding: input.binding,
          previousLiveSessions,
          previousMcpSession,
        });
        return yield* Effect.failCause(bindingExit.cause);
      }
      yield* McpSessionRegistry.revokeActiveMcpThreadExcept(
        input.binding.threadId,
        issuedMcpCredential?.config.providerSessionId,
      );
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    /** Stop is the explicit recovery path for a partial-stop binding. */
    readonly allowPartialStop?: boolean;
    /** A turn that waited behind stop must not revive the explicitly stopped session. */
    readonly allowStoppedRecovery?: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    if (isPartiallyStoppedBinding(binding) && !input.allowPartialStop) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because its provider session is in partial-stop recovery. Stop the thread before sending or controlling it.`,
      );
    }
    if (binding.status === "stopped" && input.allowStoppedRecovery === false) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because its provider session is stopped. Start the session before sending or controlling it.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    // Callers hold the per-thread transition lock for the complete routed
    // operation. Recovery must stay inside that same critical section so a
    // replacement cannot stop the session between this lookup and the first
    // provider request.
    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    const stopResults = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      instanceId === input.currentInstanceId
        ? Effect.succeed(true)
        : Effect.gen(function* () {
            const hasSession = yield* withProviderShutdownTimeout(
              adapter.hasSession(input.threadId),
              "ProviderService.stopStaleSessionsForThread.hasSession",
            );
            if (!hasSession) {
              return true;
            }

            return yield* withProviderShutdownTimeout(
              adapter.stopSession(input.threadId),
              "ProviderService.stopStaleSessionsForThread.stopSession",
            ).pipe(Effect.as(true));
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause: causeErrorTag(cause),
                  }).pipe(Effect.as(false)),
            ),
          ),
    );
    return stopResults.every(Boolean);
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* withThreadTransitionLock(threadId, () =>
        withPendingTransition(threadId, resolvedInstanceId, (adapter, isSameInstanceRestart) =>
          Effect.gen(function* () {
            const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
            const resolvedProvider = instanceInfo.driverKind;
            metricProvider = resolvedProvider;
            if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
              );
            }
            const input = {
              ...parsed,
              threadId,
              provider: resolvedProvider,
            };
            if (!instanceInfo.enabled) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
              );
            }
            const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            const previousMcpSession = McpProviderSession.readMcpProviderSession(threadId);
            // This inventory is part of the transition preflight. If it cannot
            // be read, fail before minting a credential or starting a process;
            // guessing would make compensation unable to restore an old owner.
            const previousLiveSessions = yield* findLiveSessionForThread(threadId);
            const effectiveResumeCursor =
              input.resumeCursor ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? persistedBinding.resumeCursor
                : undefined);
            const effectiveCwd =
              input.cwd ??
              (persistedBinding?.providerInstanceId === resolvedInstanceId
                ? readPersistedCwd(persistedBinding.runtimePayload)
                : undefined);
            yield* Effect.annotateCurrentSpan({
              "provider.kind": resolvedProvider,
              "provider.resume_cursor.source":
                input.resumeCursor !== undefined
                  ? "request"
                  : effectiveResumeCursor !== undefined &&
                      persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? "persisted"
                    : "none",
              "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
              "provider.cwd.source":
                input.cwd !== undefined
                  ? "request"
                  : effectiveCwd !== undefined &&
                      persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? "persisted"
                    : "none",
              "provider.cwd.effective": effectiveCwd ?? "",
            });
            const restorePreviousNativeSession = () =>
              restoreNativeSessions({
                threadId,
                targetAdapter: adapter,
                previousBinding: persistedBinding,
                previousLiveSessions,
                previousMcpSession,
              });

            // Fence every ordinary event from the retired context before the
            // adapter is allowed to replace the native session. The fence is
            // intentionally retained on a failed transition; compensation
            // must emit a fresh lifecycle event before queued output is trusted.
            if (isSameInstanceRestart) {
              yield* markRestartFence(threadId, resolvedInstanceId, adapter);
            }
            const issuedMcpExit = yield* Effect.exit(
              prepareMcpSession(threadId, resolvedInstanceId, {
                preserveExisting: true,
              }),
            );
            if (Exit.isFailure(issuedMcpExit)) {
              // No native session has been replaced yet. If credential
              // preparation fails, remove only the fence armed for this
              // transition so the still-live session remains routable.
              if (isSameInstanceRestart) {
                yield* clearRestartFence(threadId, resolvedInstanceId, adapter);
              }
              return yield* Effect.failCause(issuedMcpExit.cause);
            }
            const issuedMcpCredential = issuedMcpExit.value;
            const startedExit = yield* Effect.exit(
              adapter.startSession({
                ...input,
                providerInstanceId: resolvedInstanceId,
                ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                ...(effectiveResumeCursor !== undefined
                  ? { resumeCursor: effectiveResumeCursor }
                  : {}),
              }),
            );
            if (Exit.isFailure(startedExit)) {
              yield* restorePreviousNativeSession();
              return yield* Effect.failCause(startedExit.cause);
            }
            const session = startedExit.value;

            if (session.provider !== adapter.provider) {
              yield* restorePreviousNativeSession();
              return yield* toValidationError(
                "ProviderService.startSession",
                `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
              );
            }
            const sessionWithInstance = {
              ...session,
              providerInstanceId: resolvedInstanceId,
            };
            if (isSameInstanceRestart) {
              yield* armRestartFence(
                threadId,
                resolvedInstanceId,
                adapter,
                sessionWithInstance.createdAt,
              );
            }

            // Retire every old native session before committing the new routing
            // binding. A cleanup failure is a failed transition: roll back the
            // target process/credential and leave the old durable owner intact.
            const staleSessionsStopped = yield* stopStaleSessionsForThread({
              threadId,
              currentInstanceId: resolvedInstanceId,
            });
            if (!staleSessionsStopped) {
              yield* restorePreviousNativeSession();
              return yield* toValidationError(
                "ProviderService.startSession",
                `Cannot switch thread '${threadId}' because a stale provider session could not be stopped.`,
              );
            }
            const bindingExitAfterCleanup = yield* Effect.exit(
              upsertSessionBinding(sessionWithInstance, threadId, {
                modelSelection: input.modelSelection,
                sessionGenerationAt: sessionWithInstance.createdAt,
                sessionRestartGenerationAt: isSameInstanceRestart
                  ? sessionWithInstance.createdAt
                  : null,
              }),
            );
            if (Exit.isFailure(bindingExitAfterCleanup)) {
              yield* restorePreviousNativeSession();
              if (persistedBinding !== undefined) {
                yield* replaceRuntimeBinding(persistedBinding).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to restore provider binding after start failure", {
                      threadId,
                      cause: causeErrorTag(cause),
                    }),
                  ),
                );
              }
              return yield* Effect.failCause(bindingExitAfterCleanup.cause);
            }
            // A successful commit leaves exactly one credential for this thread.
            // This also cleans up credentials left by an earlier interrupted
            // transition, not just the one visible in the MCP routing slot.
            yield* McpSessionRegistry.revokeActiveMcpThreadExcept(
              threadId,
              issuedMcpCredential?.config.providerSessionId,
            );
            return sessionWithInstance;
          }).pipe(
            withMetrics({
              counter: providerSessionsTotal,
              attributes: () =>
                providerMetricAttributes(metricProvider, {
                  operation: "start",
                }),
            }),
          ),
        ),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    // Adapters inline attachment pixels into the model prompt, but the model's
    // tools cannot dereference pixels. Appending the on-disk path is what lets
    // a turn like "include this screenshot in the PR" copy the actual file.
    // This runs after schema decode, so the appended lines are exempt from the
    // PROVIDER_SEND_TURN_MAX_INPUT_CHARS check; attachment count is capped, so
    // the overhead is bounded. Unresolvable ids are skipped here and surface
    // as adapter errors when the file is read for inlining.
    const attachmentPathLines = attachments.flatMap((attachment) => {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      return attachmentPath === null
        ? []
        : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
    });
    const inputTextWithAttachmentPaths =
      attachmentPathLines.length === 0
        ? parsed.input
        : [parsed.input, attachmentPathLines.join("\n")]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");

    const input = {
      ...parsed,
      ...(inputTextWithAttachmentPaths !== undefined
        ? { input: inputTextWithAttachmentPaths }
        : {}),
      attachments,
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* withRoutedTurn(input.threadId, (waitedForGate) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
          allowStoppedRecovery: !waitedForGate,
        });
        metricProvider = routed.adapter.provider;
        metricModel = input.modelSelection?.model;
        yield* Effect.annotateCurrentSpan({
          "provider.kind": routed.adapter.provider,
          ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
        });
        // A turn is the clearest sign a session is still alive. The MCP
        // credential is minted once at session start and cannot be rotated into
        // an already-spawned agent process, so we keep the existing token valid
        // rather than issuing a new one: sessions that go a long time between
        // browser tool calls used to lose the toolkit outright.
        yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
        const turn = yield* routed.adapter.sendTurn(input);
        const activeMcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        if (activeMcpSession) {
          yield* McpSessionRegistry.setActiveMcpTurn(
            activeMcpSession.providerSessionId,
            turn.turnId,
          );
        }
        yield* persistRuntimeBinding({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
        return turn;
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          timer: providerTurnDuration,
          attributes: () =>
            providerTurnMetricAttributes({
              provider: metricProvider,
              model: metricModel,
              extra: {
                operation: "send",
              },
            }),
        }),
      ),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* withRoutedControl(
        input.threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.interruptTurn",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "interrupt-turn",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.turn_id": input.turnId,
          });
          yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "interrupt",
              }),
          }),
        ),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* withRoutedControl(
        input.threadId,
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.respondToRequest",
            allowRecovery: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "respond-to-request",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
            "provider.request_id": input.requestId,
          });
          yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "approval-response",
              }),
          }),
        ),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* withRoutedControl(
      input.threadId,
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToUserInput",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-user-input",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "user-input-response",
            }),
        }),
      ),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* withStoppingTransition(input.threadId, (transitionEntry) =>
        Effect.gen(function* () {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: "ProviderService.stopSession",
            allowRecovery: false,
            allowPartialStop: true,
          });
          metricProvider = routed.adapter.provider;
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "stop-session",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": input.threadId,
          });
          let stopExit: Exit.Exit<void, ProviderAdapterError | ProviderValidationError> =
            Exit.succeed(undefined);
          if (routed.isActive) {
            stopExit = yield* Effect.exit(
              withProviderShutdownTimeout(
                routed.adapter.stopSession(routed.threadId),
                "ProviderService.stopSession.stopSession",
              ),
            );
          }
          if (Exit.isFailure(stopExit)) {
            return yield* Effect.failCause(stopExit.cause);
          }
          // The native process has accepted the stop request, so revoke its
          // bearer before waiting on a turn that may be slow to unwind. A
          // timed-out turn must not retain MCP access while the user retries.
          yield* clearMcpSession(input.threadId);
          // stopSession is the control path that may be invoked while a
          // provider prompt is waiting for approval/input. The adapter stop
          // above interrupts that prompt; wait for the in-flight routed call
          // to finish before writing the stopped binding.
          const routedOperationsDrain = yield* awaitRoutedOperations(transitionEntry).pipe(
            (effect) =>
              withProviderShutdownTimeout(
                effect,
                "ProviderService.stopSession.awaitRoutedOperations",
              ),
            Effect.exit,
          );
          if (Exit.isFailure(routedOperationsDrain)) {
            return yield* toValidationError(
              "ProviderService.stopSession",
              `Timed out waiting for the provider turn on thread '${input.threadId}' to stop.`,
              routedOperationsDrain.cause,
            );
          }
          // A previous replacement may have left a stale session alive when
          // its best-effort cleanup failed. Stopping the thread is the user's
          // explicit reverse transition, so retry cleanup on every other
          // registered provider before marking the durable binding stopped.
          const staleSessionsStopped = yield* stopStaleSessionsForThread({
            threadId: input.threadId,
            currentInstanceId: routed.instanceId,
          });
          if (!staleSessionsStopped) {
            const partialStopBinding = {
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.instanceId,
              status: "error" as const,
              runtimePayload: {
                activeTurnId: null,
                routingState: "partial-stop",
                lastRuntimeEvent: "provider.stopSession.partial",
                lastRuntimeEventAt: yield* nowIso,
              },
            } satisfies ProviderSessionDirectory.ProviderRuntimeBinding;
            const partialStop = yield* Effect.exit(persistRuntimeBinding(partialStopBinding));
            if (Exit.isFailure(partialStop)) {
              yield* Effect.logWarning(
                "ProviderService.stopSession: failed to persist partial stop",
                {
                  threadId: input.threadId,
                  provider: routed.adapter.provider,
                  cause: causeErrorTag(partialStop.cause),
                },
              );
              // Persistence is unavailable, but accepting late provider
              // events is worse than temporarily losing the durable marker.
              // Keep the in-memory route fail-closed and let the next service
              // reconciliation retry the write.
              yield* Effect.uninterruptible(rememberRuntimeBinding(partialStopBinding));
            }
            return yield* toValidationError(
              "ProviderService.stopSession",
              `Cannot stop thread '${input.threadId}' because a stale provider session could not be stopped.`,
            );
          }
          yield* persistRuntimeBinding({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              routingState: null,
            },
          });
        }).pipe(
          withMetrics({
            counter: providerSessionsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: "stop",
              }),
          }),
        ),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessionsByThread = new Map<ThreadId, ProviderSession[]>();
      for (const session of activeSessions) {
        const current = sessionsByThread.get(session.threadId);
        if (current) {
          current.push(session);
        } else {
          sessionsByThread.set(session.threadId, [session]);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const [threadId, candidates] of sessionsByThread) {
        const binding = bindingsByThreadId.get(threadId);
        if (!binding) {
          // Legacy/unbound sessions have no durable owner to prefer. Keep the
          // first deterministic live entry, but never expose duplicate rows
          // for the same thread to callers.
          sessions.push(candidates[0]!);
          continue;
        }

        const bindingInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        const matching = candidates.find(
          (candidate) =>
            candidate.provider === binding.provider &&
            candidate.providerInstanceId === bindingInstanceId,
        );
        const session = matching ?? candidates[0];
        if (!session) continue;

        if (candidates.length > 1) {
          yield* Effect.logWarning(
            "ProviderService.listSessions: duplicate live sessions; selecting the persisted binding",
            {
              threadId,
              bindingProvider: binding.provider,
              bindingInstanceId,
              liveProviders: candidates.map((candidate) => candidate.provider),
              liveInstanceIds: candidates.map((candidate) => candidate.providerInstanceId),
              selectedProvider: session.provider,
              selectedInstanceId: session.providerInstanceId,
            },
          );
        }

        const matchesBinding =
          binding.provider === session.provider && bindingInstanceId === session.providerInstanceId;
        if (!matchesBinding) {
          // The initial adapter snapshot may race a provider switch. Re-read
          // both sides while holding the same transition lock used by routed
          // operations. Only a single unambiguous live session may repair a
          // stale binding; otherwise fail closed instead of presenting a
          // session that sendTurn would route elsewhere.
          const reconciled = yield* withThreadTransitionLock(threadId, () =>
            Effect.gen(function* () {
              const latestBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
              const latestCandidates = yield* findLiveSessionForThread(threadId);
              if (!latestBinding) return undefined;
              const latestInstanceId = dieOnMissingBindingInstanceId(
                "ProviderService.listSessions",
                latestBinding,
              );
              const latestMatch = latestCandidates.find(
                (candidate) =>
                  candidate.session.provider === latestBinding.provider &&
                  candidate.instanceId === latestInstanceId,
              );
              if (latestMatch) {
                return {
                  session: {
                    ...latestMatch.session,
                    providerInstanceId: latestMatch.instanceId,
                  },
                  binding: latestBinding,
                } as const;
              }
              if (latestCandidates.length !== 1) {
                yield* Effect.logWarning(
                  "ProviderService.listSessions: unresolved session/binding split-brain",
                  {
                    threadId,
                    bindingProvider: latestBinding.provider,
                    bindingInstanceId: latestInstanceId,
                    liveProviders: latestCandidates.map((candidate) => candidate.session.provider),
                    liveInstanceIds: latestCandidates.map((candidate) => candidate.instanceId),
                  },
                );
                return undefined;
              }
              const live = latestCandidates[0]!;
              const liveSession = {
                ...live.session,
                providerInstanceId: live.instanceId,
                ...(live.session.resumeCursor === undefined &&
                latestBinding.resumeCursor !== undefined
                  ? { resumeCursor: latestBinding.resumeCursor }
                  : {}),
              };
              const persistedModelSelection = readPersistedModelSelection(
                latestBinding.runtimePayload,
              );
              const repairExit = yield* Effect.exit(
                upsertSessionBinding(liveSession, threadId, {
                  sessionGenerationAt: liveSession.createdAt,
                  sessionRestartGenerationAt: null,
                  ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
                }),
              );
              if (Exit.isFailure(repairExit)) {
                yield* Effect.logWarning(
                  "ProviderService.listSessions: failed to repair session/binding mismatch",
                  {
                    threadId,
                    sessionProvider: live.session.provider,
                    sessionInstanceId: live.instanceId,
                    cause: causeErrorTag(repairExit.cause),
                  },
                );
                return undefined;
              }
              return {
                session: liveSession,
                binding: {
                  ...latestBinding,
                  provider: live.session.provider,
                  providerInstanceId: live.instanceId,
                },
              } as const;
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("ProviderService.listSessions: failed to reconcile session state", {
                threadId,
                cause: causeErrorTag(cause),
              }).pipe(Effect.as(undefined)),
            ),
          );
          if (reconciled) {
            sessions.push(
              Object.assign({}, reconciled.session, {
                providerInstanceId: dieOnMissingBindingInstanceId(
                  "ProviderService.listSessions",
                  reconciled.binding,
                ),
                ...(reconciled.session.resumeCursor === undefined &&
                reconciled.binding.resumeCursor !== undefined
                  ? { resumeCursor: reconciled.binding.resumeCursor }
                  : {}),
                ...(reconciled.binding.runtimeMode !== undefined
                  ? { runtimeMode: reconciled.binding.runtimeMode }
                  : {}),
              }),
            );
          }
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = { providerInstanceId: bindingInstanceId };
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const assertConversationRollbackSupported: ProviderServiceMethod<"assertConversationRollbackSupported"> =
    Effect.fn("assertConversationRollbackSupported")(function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.assertConversationRollbackSupported",
        allowRecovery: false,
      });
      if (routed.adapter.capabilities.supportsConversationRollback === false) {
        return yield* toValidationError(
          "ProviderService.assertConversationRollbackSupported",
          `Provider '${routed.adapter.provider}' does not support conversation rewind.`,
        );
      }
    });

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    yield* assertConversationRollbackSupported(input.threadId);
    let metricProvider = "unknown";
    return yield* withThreadTransitionLock(input.threadId, (waitedForGate) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.rollbackConversation",
          allowRecovery: true,
          allowStoppedRecovery: !waitedForGate,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "rollback-conversation",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.rollback_turns": input.numTurns,
        });
        yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "rollback",
            }),
        }),
      ),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const firstShutdown = yield* beginShutdown;
    if (!firstShutdown) return;

    const logFailure = (operation: string, cause: Cause.Cause<unknown>) =>
      Effect.logWarning("provider shutdown cleanup failed", {
        operation,
        cause: causeErrorTag(cause),
      });

    const threadIds = yield* directory.listThreadIds().pipe(
      Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
      Effect.catchCause((cause) =>
        logFailure("directory.listThreadIds", cause).pipe(Effect.as([])),
      ),
    );
    const initialAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(initialAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
        Effect.catchCause((cause) =>
          logFailure(`adapter.listSessions:${String(instanceId)}`, cause).pipe(
            Effect.as([] as Array<ProviderSession>),
          ),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));

    // Preserve a final runtime snapshot where possible, but never let one
    // broken adapter or database write prevent the remaining providers from
    // being stopped and their credentials revoked.
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
          allowDuringShutdown: true,
        }).pipe(Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS), Effect.exit),
      ).pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) ? logFailure("directory.snapshot", exit.cause) : Effect.void,
        ),
      ),
    );

    const stopAdapterPass = (
      adapters: ReadonlyArray<
        readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]
      >,
    ) =>
      Effect.forEach(
        adapters,
        ([instanceId, adapter]) =>
          adapter.stopAll().pipe(
            Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? logFailure(`adapter.stopAll:${String(instanceId)}`, exit.cause)
                : Effect.void,
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );

    yield* stopAdapterPass(initialAdapters);
    // Starts/turns that were already admitted before shutdown may still be
    // draining. Their adapters are stopped once more after the activity gate
    // reaches zero so a process created during the first pass cannot survive.
    const activityDrain = yield* awaitServiceActivityIdle.pipe(
      Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
      Effect.exit,
    );
    if (Exit.isFailure(activityDrain)) {
      yield* logFailure("service.activity.drain", activityDrain.cause);
      // Do not let an admitted operation keep a write permit forever and
      // resurrect a running binding after the finalizer. Interrupt its fiber,
      // then give all `ensuring` clauses a bounded opportunity to release
      // semaphores and credentials before the final stopped writes below.
      yield* interruptActiveServiceFibers;
      yield* awaitServiceActivityIdle.pipe(
        Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
        Effect.catchCause((cause) => logFailure("service.activity.drain.afterInterrupt", cause)),
      );
    }
    yield* stopAdapterPass(yield* getAdapterEntries);

    yield* revokeAllMcpCredentialsDuringShutdown.pipe(
      Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
      Effect.catchCause((cause) => logFailure("mcp.revokeAll", cause)),
    );

    const bindings = yield* directory.listBindings().pipe(
      Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
      Effect.catchCause((cause) => logFailure("directory.listBindings", cause).pipe(Effect.as([]))),
    );
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        const lastRuntimeEventAt = yield* nowIso;
        const stopped = yield* Effect.exit(
          persistRuntimeBinding(
            {
              threadId: binding.threadId,
              provider: binding.provider,
              providerInstanceId,
              status: "stopped",
              runtimePayload: {
                activeTurnId: null,
                routingState: null,
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt,
              },
            },
            { allowDuringShutdown: true },
          ).pipe(Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS)),
        );
        if (Exit.isFailure(stopped)) {
          yield* logFailure("directory.markStopped", stopped.cause);
        }
      }).pipe(Effect.catchCause((cause) => logFailure("directory.markStopped", cause))),
    );
    // A timed-out admitted operation may have completed its final MCP-side
    // cleanup after the first revoke. Serialize one last revoke so no token
    // survives finalizer work that raced the activity drain.
    yield* revokeAllMcpCredentialsDuringShutdown.pipe(
      Effect.timeout(PROVIDER_SHUTDOWN_OPERATION_TIMEOUT_MILLIS),
      Effect.catchCause((cause) => logFailure("mcp.revokeAll.final", cause)),
    );
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  const uploadFeedback: ProviderServiceMethod<"uploadFeedback"> = Effect.fn("uploadFeedback")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.uploadFeedback",
        schema: ProviderUploadFeedbackInput,
        payload: rawInput,
      });
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.uploadFeedback",
        allowRecovery: false,
      });
      if (routed.adapter.uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.uploadFeedback",
          allowRecovery: true,
        });
      }
      const upload = routed.adapter.uploadFeedback;
      if (upload === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      return yield* upload(input);
    },
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    assertConversationRollbackSupported,
    rollbackConversation,
    uploadFeedback,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
    subscribeEvents: PubSub.subscribe(runtimeEventPubSub).pipe(
      Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
    ),
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
