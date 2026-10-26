import {
  D4AgentActionRecord,
  D4AgentTranscriptEntry,
  D4AgentOpenSession,
  D4BrainContext,
  IsoDateTime,
  D4AgentError,
  D4AgentTurnUsage,
  D4AgentSystemCheck,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@d4research/contracts";
import { randomUuidV4 } from "@d4research/provider-core/server/randomUuid";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

export const StoredSession = Schema.Struct({
  ...D4AgentOpenSession.fields,
  scopeHash: Schema.String,
  seedSummary: Schema.optionalKey(Schema.String),
});
export type StoredSession = typeof StoredSession.Type;
export const StoredAgentThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  context: D4BrainContext,
  actionId: Schema.String,
  reportedAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  undoDisabled: Schema.Boolean,
  pipelineId: Schema.optionalKey(Schema.String),
  pipelineHash: Schema.optionalKey(Schema.String),
  scopeHash: Schema.optionalKey(Schema.String),
  // Set while the task has no active run, pending request, or background work.
  settledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
// The approved scope of a task thread. Kept apart from the bounded monitoring record so a settled
// task that monitoring forgot can still run follow-up turns in the scope it was approved for.
export const StoredTaskScope = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  context: D4BrainContext,
  pipelineId: Schema.optionalKey(Schema.String),
  pipelineHash: Schema.optionalKey(Schema.String),
  scopeHash: Schema.optionalKey(Schema.String),
});
export const StoredState = Schema.Struct({
  pendingRetirements: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        providerSessionId: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  userMessages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        messageId: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  agentThreads: Schema.optionalKey(Schema.Array(StoredAgentThread)),
  reminders: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        context: D4BrainContext,
        text: Schema.String,
        at: IsoDateTime,
      }),
    ),
  ),
  // Scheduled tasks Nia created; it may cancel only these.
  scheduledTasks: Schema.optionalKey(
    Schema.Array(Schema.Struct({ taskId: ScheduledTaskId, context: D4BrainContext })),
  ),
  taskScopes: Schema.optionalKey(Schema.Array(StoredTaskScope)),
  sessions: Schema.optionalKey(Schema.Array(StoredSession)),
  chatThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  transcript: Schema.optionalKey(Schema.Array(D4AgentTranscriptEntry)),
  rotation: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        threadId: ThreadId,
        context: D4BrainContext,
        messageId: Schema.String,
        pendingText: Schema.String,
        requestedAt: IsoDateTime,
        heartbeat: Schema.optionalKey(Schema.Boolean),
        // Stable identity of the pending message, reused by every delivery retry.
        deliveryId: Schema.optionalKey(Schema.String),
        // Set once the summary outcome is decided; the record then stays until delivery is accepted.
        targetThreadId: Schema.optionalKey(ThreadId),
        seedSummary: Schema.optionalKey(Schema.String),
        notice: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  lastUserText: Schema.optionalKey(Schema.String),
  sessionChangeReason: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["context", "new-session", "resumed", "size"])),
  ),
  retiringProviderSessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  retiringThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  brainContext: D4BrainContext.pipe(Schema.withDecodingDefault(Effect.succeed("Global"))),
  contextChangedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  contextScopeHash: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  bindings: Schema.Array(
    Schema.Struct({ sessionId: Schema.String, threadId: ThreadId, context: D4BrainContext }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  identityReady: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  automaticActions: Schema.Array(
    Schema.Struct({ scope: Schema.String, target: Schema.String, at: Schema.Number }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  actions: Schema.Array(D4AgentActionRecord),
  usage: Schema.Array(D4AgentTurnUsage),
  usageCursor: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  systemEpisodes: Schema.Array(
    Schema.Struct({ check: D4AgentSystemCheck, since: Schema.Number, baseline: Schema.Boolean }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  systemClaims: Schema.Array(
    Schema.Struct({ reportKey: Schema.String, clientId: Schema.String, at: Schema.Number }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  heartbeatAt: Schema.Number,
  heartbeatKeys: Schema.Array(Schema.String),
});
export type StoredState = typeof StoredState.Type;
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(StoredState));
const empty: StoredState = {
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
};
export function ctoPreview(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= 4096
    ? text
    : new TextDecoder().decode(bytes.slice(0, 4080), { stream: true }) + "… [truncated]";
}

// Active tasks are bounded at admission. Only the newest settled tasks keep their monitoring
// record. Their approved scope stays in taskScopes, so follow-up turns keep working.
const SETTLED_AGENT_THREAD_LIMIT = 1000;
// A task beyond this many newer ones loses its scope and its turns are refused (fail closed).
const TASK_SCOPE_LIMIT = 20_000;
function scopeOf(entry: typeof StoredAgentThread.Type): typeof StoredTaskScope.Type {
  return {
    threadId: entry.threadId,
    projectId: entry.projectId,
    context: entry.context,
    ...(entry.pipelineId !== undefined ? { pipelineId: entry.pipelineId } : {}),
    ...(entry.pipelineHash !== undefined ? { pipelineHash: entry.pipelineHash } : {}),
    ...(entry.scopeHash !== undefined ? { scopeHash: entry.scopeHash } : {}),
  };
}
// Every monitored task has its scope recorded; a monitoring record wins over an older scope.
function boundTaskScopes(state: StoredState): ReadonlyArray<typeof StoredTaskScope.Type> {
  const monitored = new Map((state.agentThreads ?? []).map((entry) => [entry.threadId, entry]));
  const scopes = (state.taskScopes ?? []).filter((entry) => !monitored.has(entry.threadId));
  return [...scopes, ...[...monitored.values()].map(scopeOf)].slice(-TASK_SCOPE_LIMIT);
}

/** Removes a task's approved scope as well as its monitoring record (failed creation, deletion). */
export function revokeTasks(state: StoredState, threadIds: ReadonlySet<ThreadId>): StoredState {
  return {
    ...state,
    agentThreads: (state.agentThreads ?? []).filter((entry) => !threadIds.has(entry.threadId)),
    taskScopes: (state.taskScopes ?? []).filter((entry) => !threadIds.has(entry.threadId)),
  };
}
function boundAgentThreads(
  entries: ReadonlyArray<typeof StoredAgentThread.Type>,
): ReadonlyArray<typeof StoredAgentThread.Type> {
  let settled = 0;
  return entries
    .toReversed()
    .filter((entry) => entry.settledAt == null || ++settled <= SETTLED_AGENT_THREAD_LIMIT)
    .toReversed();
}

export function boundStoredState(state: StoredState, now: number): StoredState {
  const ctoIds = new Set(
    state.actions
      .filter((a) => a.action.type === "cto-ask" && a.result !== undefined)
      .slice(-10)
      .map((a) => a.id),
  );
  let completed = 0;
  const actions = state.actions
    .filter(
      (action) =>
        action.action.type !== "auto-archive" ||
        now - Date.parse(action.createdAt) < 30 * 86_400_000,
    )
    .toReversed()
    .filter((action) => action.status === "pending" || ++completed <= 200)
    .toReversed();
  return {
    ...state,
    userMessages: (state.userMessages ?? []).slice(-200),
    sessions: (state.sessions ?? [])
      .filter(
        (entry, index, all) =>
          all.findLastIndex((other) => other.context === entry.context) === index,
      )
      .slice(-4),
    chatThreadIds: (state.chatThreadIds ?? []).slice(-256),
    agentThreads: boundAgentThreads(state.agentThreads ?? []),
    taskScopes: boundTaskScopes(state),
    transcript: (state.transcript ?? []).slice(-200),
    bindings: state.bindings
      .filter(
        (binding) =>
          binding.threadId === state.threadId ||
          state.sessions?.some((session) => session.threadId === binding.threadId),
      )
      .slice(-16),
    actions: actions.map((action) => {
      if (action.action.type !== "cto-ask" || action.result === undefined) return action;
      const { result, ...without } = action;
      return ctoIds.has(action.id) ? { ...without, result: ctoPreview(result) } : without;
    }),
  };
}

export class D4AgentStore extends Context.Service<
  D4AgentStore,
  {
    readonly workspace: string;
    readonly get: Effect.Effect<StoredState>;
    readonly update: (
      change: (state: StoredState) => StoredState,
    ) => Effect.Effect<StoredState, D4AgentError>;
  }
>()("d4research/d4Agent/D4AgentStore") {}

export const layer = Layer.effect(
  D4AgentStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "d4-agent");
    const statePath = path.join(directory, "state.json");
    const lock = yield* Semaphore.make(1);
    const initial = yield* fs.readFileString(statePath).pipe(
      Effect.flatMap((content) =>
        decodeState(content).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const quarantinePath = `${statePath}.corrupt-${yield* Clock.currentTimeMillis}-${yield* randomUuidV4}`;
              yield* fs.rename(statePath, quarantinePath);
              yield* Effect.logWarning("d4 Agent state was invalid; quarantined and reset", {
                quarantinePath,
              });
              return empty;
            }),
          ),
        ),
      ),
      Effect.catch((cause) =>
        cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
          ? Effect.succeed(empty)
          : Effect.fail(new D4AgentError({ reason: "storage", cause })),
      ),
    );
    const loadedAt = yield* Clock.currentTimeMillis;
    const state = yield* Ref.make<StoredState>(
      boundStoredState(
        {
          ...initial,
          actions: initial.actions.map((action) =>
            action.action.type === "cto-ask" && action.result === "Asked, answer will be posted."
              ? {
                  ...action,
                  status: "failed",
                  result: "CTO question interrupted by server restart; no automatic retry.",
                }
              : action.status === "approved"
                ? { ...action, status: "pending" }
                : action,
          ),
        },
        loadedAt,
      ),
    );
    let persisted = yield* encodeState(initial);
    return D4AgentStore.of({
      workspace: path.join(directory, "workspace"),
      get: Ref.get(state),
      update: (change) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const now = yield* Clock.currentTimeMillis;
            const next = yield* Effect.try({
              try: () => boundStoredState(change(current), now),
              catch: (cause) =>
                Schema.is(D4AgentError)(cause)
                  ? cause
                  : new D4AgentError({ reason: "storage", cause }),
            });
            const encoded = yield* encodeState(next);
            if (encoded === persisted) return current;
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(`${statePath}.tmp`, encoded, {
              mode: 0o600,
            });
            yield* fs.rename(`${statePath}.tmp`, statePath);
            yield* Ref.set(state, next);
            persisted = encoded;
            return next;
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(D4AgentError)(cause)
                ? cause
                : new D4AgentError({ reason: "storage", cause }),
            ),
          ),
        ),
    });
  }),
);
