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

export const makeTaskScopeValidator = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(Store.D4AgentStore);
  return Effect.fn("D4AgentTaskScope.validate")(function* (
    threadId: ThreadId,
    settings: D4AgentSettings,
    pipelineId?: string,
    pipelines?: Pick<ServerSettings, "dev" | "research">,
  ) {
    if (!String(threadId).startsWith("d4-action:")) return null;
    const record = Option.isSome(store)
      ? (yield* store.value.get).agentThreads?.find((entry) => entry.threadId === threadId)
      : undefined;
    if (
      record === undefined ||
      record.scopeHash !==
        taskScopeHash(record.context, settings, record.projectId, record.pipelineId) ||
      !projectActionInScope(record.context, settings, record.projectId) ||
      (pipelineId !== undefined && record.pipelineId !== pipelineId)
    )
      return yield* new D4AgentError({ reason: "context" });
    if (record.pipelineId !== undefined) {
      const separator = record.pipelineId.indexOf(":");
      const kind = record.pipelineId.slice(0, separator);
      const name = record.pipelineId.slice(separator + 1);
      const scenario =
        kind === "dev" || kind === "research"
          ? pipelines?.[kind].scenarios.find((entry) => entry.name === name)
          : undefined;
      if (
        scenario === undefined ||
        (kind !== "dev" && kind !== "research") ||
        pipelineFingerprint({ ...scenario, kind }) !== record.pipelineHash
      )
        return yield* new D4AgentError({ reason: "context" });
      const associatedProject = settings.pipelineProjects[record.pipelineId];
      if (
        associatedProject !== undefined
          ? associatedProject !== record.projectId
          : record.context !== "Global"
      )
        return yield* new D4AgentError({ reason: "context" });
    }
    return record;
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
  if (["research_delegate", "pipeline_list", "pipeline_get"].includes(name)) return true;
  if (callerTools.has(name)) return true;
  if (!ownThreadTools.has(name)) return false;
  const target = request.params?.arguments?.threadId;
  return target === undefined || target === threadId;
};
