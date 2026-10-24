import { assert, it } from "@effect/vitest";
import {
  DEFAULT_D4_AGENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "./D4AgentContext.ts";
import * as Store from "./D4AgentStore.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Monitor from "../orchestration-v2/AgentMonitorReactor.ts";
const model = { instanceId: ProviderInstanceId.make("codex"), model: "selected" };
const ownId = ThreadId.make("owned");
const provider: ServerProvider = {
  instanceId: model.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T12:00:00Z",
  models: [{ slug: model.model, name: "Selected", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};
const layer = Context.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Store.D4AgentStore)({
        workspace: "/isolated",
        get: Effect.succeed({
          threadId: ownId,
          projectId: null,
          actions: [],
          usage: [],
          usageCursor: "",
          heartbeatAt: 0,
          heartbeatKeys: [],
          systemEpisodes: [],
          systemClaims: [],
        }),
      }),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Settings.layerTest({
        d4Agent: { ...DEFAULT_D4_AGENT_SETTINGS, enabled: true, modelSelection: model },
      }),
      Layer.mock(Monitor.AgentMonitorReactor)({ snapshot: Effect.succeed([]) }),
    ),
  ),
);
it.effect(
  "normal threads keep their provider path while the owned thread receives the fixed prefix",
  () =>
    Effect.gen(function* () {
      const context = yield* Context.D4AgentContext;
      assert.equal(
        yield* context.prepare(ThreadId.make("ordinary"), { ...model, model: "different" }),
        null,
      );
      const prefix = yield* context.prepare(ownId, model);
      assert.isTrue(prefix?.startsWith("You are d4 Agent"));
      assert.isTrue(prefix?.includes('"counts":{}'));
    }).pipe(Effect.provide(layer)),
);
it.effect("the normal composer cannot switch the owned thread away from the selected model", () =>
  Effect.gen(function* () {
    const context = yield* Context.D4AgentContext;
    const result = yield* Effect.result(context.prepare(ownId, { ...model, model: "different" }));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "model-unavailable");
  }).pipe(Effect.provide(layer)),
);
