import { pipelineFingerprint } from "./PipelineCatalog.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_D4_AGENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Store from "./D4AgentStore.ts";
import { taskScopeHash } from "./brainScope.ts";
import { isAllowedTaskMcpRequest, validateAgentTaskScope } from "./D4AgentTaskScope.ts";

const projectId = ProjectId.make("yb");
const threadId = ThreadId.make("d4-action:task");
const settings = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  projectContexts: { [projectId]: "YB" as const },
  pipelineProjects: { "research:yb": projectId },
};
const scenario = {
  kind: "research" as const,
  name: "yb",
  pipelinePrompt: "Scoped pipeline",
  promptFiles: [],
};
const pipelines = {
  dev: DEFAULT_SERVER_SETTINGS.dev,
  research: { ...DEFAULT_SERVER_SETTINGS.research, scenarios: [scenario] },
};
const record = {
  threadId,
  projectId,
  context: "YB" as const,
  actionId: "task",
  reportedAt: null,
  archivedAt: null,
  undoDisabled: false,
  scopeHash: taskScopeHash("YB", settings, projectId, "research:yb"),
  pipelineId: "research:yb",
  pipelineHash: pipelineFingerprint(scenario),
};
const layer = Layer.mock(Store.D4AgentStore)({
  workspace: "/isolated/agent",
  get: Effect.succeed({ agentThreads: [record] } as unknown as Store.StoredState),
});

it.effect("scoped tasks refuse missing ownership, changed mappings and another pipeline", () =>
  Effect.gen(function* () {
    assert.equal(
      (yield* Effect.result(validateAgentTaskScope(threadId, settings)))._tag,
      "Failure",
    );
    yield* Effect.gen(function* () {
      const changed = yield* Effect.result(
        validateAgentTaskScope(threadId, settings, "research:yb", {
          ...pipelines,
          research: {
            ...pipelines.research,
            scenarios: [{ ...scenario, pipelinePrompt: "Changed" }],
          },
        }),
      );
      assert.equal(changed._tag, "Failure");
      assert.deepEqual(
        yield* validateAgentTaskScope(threadId, settings, "research:yb", pipelines),
        record,
      );
      assert.equal(
        (yield* Effect.result(validateAgentTaskScope(threadId, settings, "dev:secret", pipelines)))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          validateAgentTaskScope(threadId, {
            ...settings,
            projectContexts: { [projectId]: "Dimaggi" },
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          validateAgentTaskScope(threadId, { ...settings, pipelineProjects: {} }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer));
    assert.isNull(yield* validateAgentTaskScope(ThreadId.make("ordinary-user-thread"), settings));
  }),
);

it("task MCP policy permits its own tools and refuses unscoped retrieval and cross-thread reads", () => {
  const request = (name: string, args: Record<string, unknown> = {}) => ({
    method: "tools/call",
    params: { name, arguments: args },
  });
  for (const name of [
    "research_delegate",
    "pipeline_list",
    "pipeline_get",
    "t3_worktree_status",
    "t3_worktree_handoff",
    "skills_search",
  ])
    assert.isTrue(isAllowedTaskMcpRequest(request(name), threadId));
  assert.isTrue(isAllowedTaskMcpRequest(request("t3_thread_read", { threadId }), threadId));
  assert.isFalse(
    isAllowedTaskMcpRequest(request("t3_thread_read", { threadId: "dimaggi-thread" }), threadId),
  );
  for (const name of [
    "memory_search",
    "brain_search",
    "t3_thread_search",
    "t3_thread_list",
    "pipeline_upsert",
    "pipeline_delete",
    "delegate_task",
    "create_threads",
  ])
    assert.isFalse(isAllowedTaskMcpRequest(request(name), threadId));
  assert.isFalse(isAllowedTaskMcpRequest([request("pipeline_list")], threadId));
  assert.isFalse(isAllowedTaskMcpRequest({ method: "resources/read" }, threadId));
});

it.effect(
  "Global tasks survive unrelated mappings and refuse their own project or pipeline remap",
  () =>
    Effect.gen(function* () {
      const target = ProjectId.make("unmapped-target");
      const baseline = { ...DEFAULT_D4_AGENT_SETTINGS };
      const globalRecord = {
        ...record,
        projectId: target,
        context: "Global" as const,
        scopeHash: taskScopeHash("Global", baseline, target, record.pipelineId),
      };
      const dependencies = Layer.mock(Store.D4AgentStore)({
        workspace: "/isolated/agent",
        get: Effect.succeed({ agentThreads: [globalRecord] } as unknown as Store.StoredState),
      });
      yield* Effect.gen(function* () {
        const unrelated = {
          ...baseline,
          projectContexts: { [ProjectId.make("elsewhere")]: "YB" as const },
          pipelineProjects: { "dev:elsewhere": ProjectId.make("elsewhere") },
        };
        assert.deepEqual(
          yield* validateAgentTaskScope(threadId, unrelated, record.pipelineId, pipelines),
          globalRecord,
        );
        for (const changed of [
          {
            ...unrelated,
            projectContexts: { ...unrelated.projectContexts, [target]: "Personal" as const },
          },
          {
            ...unrelated,
            pipelineProjects: { ...unrelated.pipelineProjects, [record.pipelineId]: target },
          },
          {
            ...unrelated,
            pipelineProjects: {
              ...unrelated.pipelineProjects,
              [record.pipelineId]: ProjectId.make("elsewhere"),
            },
          },
        ]) {
          assert.equal(
            (yield* Effect.result(
              validateAgentTaskScope(threadId, changed, record.pipelineId, pipelines),
            ))._tag,
            "Failure",
          );
        }
      }).pipe(Effect.provide(dependencies));
    }),
);
