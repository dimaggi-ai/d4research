import { toolkitRegistration } from "../McpHttpServer.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  RunId,
  type OrchestrationV2ThreadShell,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { McpInvocationContext, type McpInvocationScope } from "../McpInvocationContext.ts";
import { MemoryToolkit, MemoryHandlersLive } from "./memory.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "memory-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memory-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "memory-test",
  client: undefined,
  thread: {
    threadId: ThreadId.make("memory-a"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerSessionId: "memory-test",
  },
  capabilities: new Set(["memory"]),
  issuedAt: 1,
};
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe("2026-09-08"),
    updatedAt: DateTime.makeUnsafe("2026-09-08"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const testLayer = toolkitRegistration(MemoryToolkit, MemoryHandlersLive).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          shell({
            id,
            providerInstanceId: ProviderInstanceId.make("claude"),
            activeRunId: RunId.make("memory-run"),
          }),
        ),
    }),
  ),
);

it.effect(
  "MCP saves and reads only its thread's project, without returning full contents on list or save",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["a", "b"]) {
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Project', '/test', '[]', '2026-09-08', '2026-09-08')`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${`memory-${id}`}, ${id}, 'Thread', 'claude', 'full-access', 'default', '2026-09-08', '2026-09-08', '{}')`;
      }
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const saved = yield* call("project_memory_save", {
        name: "hosts",
        description: "Before deployment",
        content: "Private inventory location",
      });
      expect(saved.isError).not.toBe(true);
      expect(encodeJson(saved)).not.toContain("Private inventory location");
      const index = yield* call("project_memory_list", {});
      expect(encodeJson(index)).toContain("Before deployment");
      expect(encodeJson(index)).not.toContain("Private inventory location");
      expect(encodeJson(yield* call("project_memory_read", { name: "hosts" }))).toContain(
        "Private inventory location",
      );
      const other = yield* call(
        "project_memory_read",
        { name: "hosts" },
        { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("memory-b") } },
      );
      expect(other.isError).toBe(true);
      const denied = yield* call(
        "project_memory_list",
        {},
        { ...scope, capabilities: new Set(["preview"]) },
      );
      expect(denied.isError).toBe(true);
      const invalid = yield* Effect.exit(
        call("project_memory_save", { name: "../bad", description: "bad", content: "bad" }),
      );
      expect(invalid._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
);
