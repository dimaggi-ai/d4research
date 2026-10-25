import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { PipelinesToolkit } from "./tools.ts";
import { PipelinesToolkitHandlersLive } from "./handlers.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Store from "../../../d4Agent/D4AgentStore.ts";
import { contextScopeHash } from "../../../d4Agent/brainScope.ts";
import { pipelineFingerprint } from "../../../d4Agent/PipelineCatalog.ts";

it.effect(
  "task pipeline reads expose only the approved scenario and reject other-context content",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("yb");
      const threadId = ThreadId.make("d4-action:scoped-pipeline");
      const own = { name: "yb", pipelinePrompt: "YB approved", promptFiles: [] };
      const other = { name: "dimaggi", pipelinePrompt: "Dimaggi private", promptFiles: [] };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        d4Agent: {
          ...DEFAULT_SERVER_SETTINGS.d4Agent,
          projectContexts: { [projectId]: "YB" as const },
          pipelineProjects: { "research:yb": projectId },
        },
        research: { ...DEFAULT_SERVER_SETTINGS.research, scenarios: [own, other] },
      };
      const dependencies = Layer.mergeAll(
        Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
        Layer.mock(Store.D4AgentStore)({
          workspace: "/isolated/agent",
          get: Effect.succeed({
            agentThreads: [
              {
                threadId,
                projectId,
                context: "YB",
                actionId: "scoped-pipeline",
                reportedAt: null,
                archivedAt: null,
                undoDisabled: false,
                scopeHash: contextScopeHash("YB", settings.d4Agent),
                pipelineId: "research:yb",
                pipelineHash: pipelineFingerprint({ ...own, kind: "research" }),
              },
            ],
          } as unknown as Store.StoredState),
        }),
        Layer.succeed(McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          capabilities: new Set(["research"] as const),
          issuedAt: 0,
          requestNamespace: "test",
          client: undefined,
          thread: {
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "session",
          },
        }),
      );
      const toolkit = yield* PipelinesToolkit.pipe(
        Effect.provide(PipelinesToolkitHandlersLive.pipe(Layer.provide(dependencies))),
      );
      const listed = yield* toolkit
        .handle("pipeline_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(listed.at(-1)?.result, {
        pipelines: [
          {
            kind: "research",
            name: "yb",
            active: false,
            trigger: "!research:yb",
            promptFileNames: [],
          },
        ],
      });
      const ownResult = yield* toolkit
        .handle("pipeline_get", { kind: "research", name: "yb" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.include(JSON.stringify(ownResult), "YB approved");
      const otherResult = yield* Effect.result(
        toolkit
          .handle("pipeline_get", { kind: "research", name: "dimaggi" })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
      );
      assert.equal(otherResult._tag, "Failure");
      assert.notInclude(JSON.stringify(otherResult), "Dimaggi private");
    }),
);
