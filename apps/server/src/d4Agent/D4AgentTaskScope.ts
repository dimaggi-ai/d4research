import { pipelineFingerprint } from "./PipelineCatalog.ts";
import {
  D4AgentError,
  type D4AgentSettings,
  type ServerSettings,
  type ThreadId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Store from "./D4AgentStore.ts";
import { taskScopeHash, projectActionInScope } from "./brainScope.ts";

type TaskScopeRecord =
  | NonNullable<Store.StoredState["agentThreads"]>[number]
  | NonNullable<Store.StoredState["taskScopes"]>[number];

/**
 * Why a scoped task may or may not run. Only `pipeline-changed` is
 * recoverable in place: the approved project and context still hold, and an
 * explicit resume may re-pin the task to the pipeline as it is now.
 */
export type TaskScopeStatus =
  | { readonly status: "ok"; readonly record: TaskScopeRecord }
  | { readonly status: "missing" }
  | { readonly status: "scope-changed"; readonly record: TaskScopeRecord }
  | {
      readonly status: "pipeline-changed";
      readonly record: TaskScopeRecord;
      readonly currentPipelineHash: string;
    }
  | { readonly status: "pipeline-unavailable"; readonly record: TaskScopeRecord };

export const evaluateTaskScope = (
  state: Store.StoredState | undefined,
  threadId: ThreadId,
  settings: D4AgentSettings,
  pipelineId?: string,
  pipelines?: Pick<ServerSettings, "dev" | "research">,
): TaskScopeStatus => {
  // The monitoring record when monitoring still tracks the task, otherwise its durable scope.
  const record =
    state?.agentThreads?.find((entry) => entry.threadId === threadId) ??
    state?.taskScopes?.find((entry) => entry.threadId === threadId);
  if (record === undefined) return { status: "missing" };
  if (
    record.scopeHash !==
      taskScopeHash(record.context, settings, record.projectId, record.pipelineId) ||
    !projectActionInScope(record.context, settings, record.projectId) ||
    (pipelineId !== undefined && record.pipelineId !== pipelineId)
  )
    return { status: "scope-changed", record };
  if (record.pipelineId === undefined) return { status: "ok", record };
  const separator = record.pipelineId.indexOf(":");
  const kind = record.pipelineId.slice(0, separator);
  const name = record.pipelineId.slice(separator + 1);
  const scenario =
    kind === "dev" || kind === "research"
      ? pipelines?.[kind].scenarios.find((entry) => entry.name === name)
      : undefined;
  if (scenario === undefined || (kind !== "dev" && kind !== "research"))
    return { status: "pipeline-unavailable", record };
  const associatedProject = settings.pipelineProjects[record.pipelineId];
  if (
    associatedProject !== undefined
      ? associatedProject !== record.projectId
      : record.context !== "Global"
  )
    return { status: "scope-changed", record };
  const currentPipelineHash = pipelineFingerprint({ ...scenario, kind });
  if (currentPipelineHash !== record.pipelineHash)
    return { status: "pipeline-changed", record, currentPipelineHash };
  return { status: "ok", record };
};

/** What a person needs to know when a scoped task is refused at turn start. */
export const describeTaskScopeRefusal = (status: TaskScopeStatus): string => {
  switch (status.status) {
    case "ok":
      return "";
    case "missing":
      return "This task has no approved scope record, so it cannot start. Ask Nia to start it again.";
    case "scope-changed":
      return "This task's approved project or context scope changed after approval, so it cannot start. Ask Nia to start it again under the current scope.";
    case "pipeline-unavailable":
      return `Pipeline ${status.record.pipelineId ?? ""} no longer exists in settings, so this task cannot continue.`;
    case "pipeline-changed":
      return `Pipeline ${status.record.pipelineId ?? ""} changed after this task was approved, so a plain message cannot continue it. Use Resume to continue under the current pipeline.`;
  }
};

/**
 * Re-approves a task against the pipeline as it is now. Callers must have
 * seen `pipeline-changed` and an explicit resume from an authorized caller;
 * every other scope check still binds the task.
 */
export const repinTaskPipeline = (
  state: Store.StoredState,
  threadId: ThreadId,
  pipelineHash: string,
): Store.StoredState => ({
  ...state,
  ...(state.agentThreads === undefined
    ? {}
    : {
        agentThreads: state.agentThreads.map((entry) =>
          entry.threadId === threadId ? { ...entry, pipelineHash } : entry,
        ),
      }),
  ...(state.taskScopes === undefined
    ? {}
    : {
        taskScopes: state.taskScopes.map((entry) =>
          entry.threadId === threadId ? { ...entry, pipelineHash } : entry,
        ),
      }),
});

export const makeTaskScopeValidator = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(Store.D4AgentStore);
  return Effect.fn("D4AgentTaskScope.validate")(function* (
    threadId: ThreadId,
    settings: D4AgentSettings,
    pipelineId?: string,
    pipelines?: Pick<ServerSettings, "dev" | "research">,
  ) {
    if (!String(threadId).startsWith("d4-action:")) return null;
    const state = Option.isSome(store) ? yield* store.value.get : undefined;
    const result = evaluateTaskScope(state, threadId, settings, pipelineId, pipelines);
    if (result.status !== "ok") return yield* new D4AgentError({ reason: "context" });
    return result.record;
  });
});

/** Scope verdicts for d4-action threads; null for every other thread. */
export const makeTaskScopeEvaluator = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(Store.D4AgentStore);
  return Effect.fn("D4AgentTaskScope.evaluate")(function* (
    threadId: ThreadId,
    settings: D4AgentSettings,
    pipelines?: Pick<ServerSettings, "dev" | "research">,
  ) {
    if (!String(threadId).startsWith("d4-action:")) return null;
    const state = Option.isSome(store) ? yield* store.value.get : undefined;
    return evaluateTaskScope(state, threadId, settings, undefined, pipelines);
  });
});

export const validateAgentTaskScope = Effect.fn("D4AgentTaskScope.validateCurrent")(function* (
  threadId: ThreadId,
  settings: D4AgentSettings,
  pipelineId?: string,
  pipelines?: Pick<ServerSettings, "dev" | "research">,
) {
  return yield* (yield* makeTaskScopeValidator)(threadId, settings, pipelineId, pipelines);
});

const TaskMcpRequest = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

// Scoped tasks retain development tools that operate on their own thread. Broad
// memory, search, scheduling and thread creation would escape the approved task.
const ownThreadTools = new Set([
  "t3_thread_read",
  "t3_thread_configuration",
  "t3_queue_list",
  "t3_queue_read",
  "t3_pending_request_list",
  "t3_pending_request_read",
  "t3_worktree_list",
  "link_pull_request",
  "unlink_pull_request",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "read_pull_request_guide",
]);
const callerTools = new Set([
  "t3_worktree_status",
  "t3_worktree_handoff",
  "skills_search",
  "request_secret",
]);

const decodeTaskMcpRequest = Schema.decodeUnknownOption(TaskMcpRequest);

export const isAllowedTaskMcpRequest = (value: unknown, threadId: ThreadId): boolean => {
  const decoded = decodeTaskMcpRequest(value);
  if (Option.isNone(decoded)) return false;
  const request = decoded.value;
  if (request.method !== "tools/call")
    return [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "notifications/cancelled",
    ].includes(request.method);
  const name = request.params?.name;
  if (name === undefined) return false;
  if (
    ["research_delegate", "research_artifact_read", "pipeline_list", "pipeline_get"].includes(name)
  )
    return true;
  if (callerTools.has(name)) return true;
  if (!ownThreadTools.has(name)) return false;
  const target = request.params?.arguments?.threadId;
  return target === undefined || target === threadId;
};
