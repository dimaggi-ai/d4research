import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as Pipelines from "./D4AgentPipelines.ts";
import * as Settings from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const yb = ProjectId.make("yb");
const dimaggi = ProjectId.make("dimaggi");
const global = ProjectId.make("global");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "chosen" };
const scenario = (name: string) => ({
  name,
  pipelinePrompt: `Research ${name}`,
  promptFiles: [{ name: "guide.md", content: name }],
});
const initial: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  d4Agent: {
    ...DEFAULT_SERVER_SETTINGS.d4Agent,
    projectContexts: { [yb]: "YB", [dimaggi]: "Dimaggi" },
    pipelineProjects: { "research:yb": yb, "dev:dimaggi": dimaggi },
  },
  research: {
    ...DEFAULT_SERVER_SETTINGS.research,
    scenarios: [scenario("yb"), scenario("global")],
    activeScenario: "yb",
  },
  dev: { ...DEFAULT_SERVER_SETTINGS.dev, scenarios: [scenario("dimaggi")] },
};
const fixture = () => {
  let settings = initial;
  const dispatch = vi.fn(
    (_input: Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0]) => Effect.void,
  );
  const sendToThread = vi.fn(
    (_input: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0]) =>
      Effect.void,
  );
  const services = Layer.mergeAll(
    Layer.succeed(Settings.ServerSettingsService, {
      getSettings: Effect.sync(() => settings),
    } as unknown as Settings.ServerSettingsService["Service"]),
    Layer.succeed(Threads.ThreadManagementService, {
      dispatch,
      sendToThread,
    } as unknown as Threads.ThreadManagementService["Service"]),
  );
  return {
    dispatch,
    sendToThread,
    update: (next: ServerSettings) => {
      settings = next;
    },
    layer: Pipelines.layer.pipe(Layer.provide(services)),
  };
};

it.effect("work contexts list their own pipelines and Global lists every pipeline", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Pipelines.D4AgentPipelines;
      assert.deepEqual(
        (yield* service.list("YB")).map((p) => p.pipelineId),
        ["research:yb"],
      );
      assert.deepEqual(
        (yield* service.list("Dimaggi")).map((p) => p.pipelineId),
        ["dev:dimaggi"],
      );
      assert.deepEqual(
        (yield* service.list("Global")).map((p) => p.pipelineId),
        ["dev:dimaggi", "research:yb", "research:global"],
      );
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "approved pipeline uses existing thread creation and send services with the exact reviewed prompt",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Pipelines.D4AgentPipelines;
        const prepared = yield* service.prepare(
          {
            type: "research",
            pipelineId: "research:yb",
            projectId: yb,
            text: "Detailed task",
            modelSelection,
          },
          "YB",
        );
        assert.equal(f.dispatch.mock.calls.length, 0);
        assert.equal(f.sendToThread.mock.calls.length, 0);
        assert.equal(prepared.pipelinePrompt, "Research yb");
        assert.deepEqual(prepared.promptFiles, [{ name: "guide.md", content: "yb" }]);
        yield* service.execute({ actionId: "approved", context: "YB", prepared });
        assert.equal(f.dispatch.mock.calls.length, 1);
        assert.equal(f.sendToThread.mock.calls.length, 1);
        assert.deepInclude(f.dispatch.mock.calls[0]?.[0], {
          type: "thread.create",
          createdBy: "agent",
          projectId: yb,
          modelSelection,
        });
        assert.deepInclude(f.sendToThread.mock.calls[0]?.[0], {
          text: "!research:yb\n\nDetailed task",
          createdBy: "agent",
          projectId: yb,
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("refuses pipeline edits and context remapping after approval preparation", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Pipelines.D4AgentPipelines;
      const prepared = yield* service.prepare(
        {
          type: "research",
          pipelineId: "research:yb",
          projectId: yb,
          text: "Task",
          modelSelection,
        },
        "YB",
      );
      f.update({
        ...initial,
        research: {
          ...initial.research,
          scenarios: [{ ...scenario("yb"), pipelinePrompt: "Changed" }],
        },
      });
      assert.equal(
        (yield* Effect.result(service.execute({ actionId: "changed", context: "YB", prepared })))
          ._tag,
        "Failure",
      );
      f.update({
        ...initial,
        d4Agent: { ...initial.d4Agent, projectContexts: { [yb]: "Dimaggi" } },
      });
      assert.equal(
        (yield* Effect.result(service.execute({ actionId: "remapped", context: "YB", prepared })))
          ._tag,
        "Failure",
      );
      assert.equal(f.sendToThread.mock.calls.length, 0);
      assert.equal(f.dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("refuses other-context pipelines and restricts unassociated pipelines to Global", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Pipelines.D4AgentPipelines;
      for (const [pipelineId, projectId] of [
        ["dev:dimaggi", yb],
        ["research:global", yb],
      ] as const) {
        assert.equal(
          (yield* Effect.result(
            service.prepare(
              { type: "pipeline", pipelineId, projectId, text: "Task", modelSelection },
              "YB",
            ),
          ))._tag,
          "Failure",
        );
      }
      yield* service.prepare(
        {
          type: "research",
          pipelineId: "research:global",
          projectId: global,
          text: "Task",
          modelSelection,
        },
        "Global",
      );
    }).pipe(Effect.provide(f.layer));
  }),
);
