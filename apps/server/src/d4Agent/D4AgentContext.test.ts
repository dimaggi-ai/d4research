import { buildServerProvider } from "@d4research/provider-core/server/snapshotProbe";
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
import * as Ref from "effect/Ref";
import * as Context from "./D4AgentContext.ts";
import * as Store from "./D4AgentStore.ts";
import { contextScopeHash } from "./brainScope.ts";
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
const testLayer = (
  state: Partial<Store.StoredState> = {},
  config = DEFAULT_D4_AGENT_SETTINGS,
  catalog = Effect.succeed<ReadonlyArray<ServerProvider>>([provider]),
) =>
  Context.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.D4AgentStore)({
          workspace: "/isolated",
          get: Effect.succeed({
            retiringThreadId: null,
            brainContext: "Global",
            contextChangedAt: null,
            contextScopeHash: contextScopeHash("Global", DEFAULT_D4_AGENT_SETTINGS),
            bindings: [],
            identityReady: true,
            automaticActions: [],
            threadId: ownId,
            projectId: null,
            actions: [],
            usage: [],
            usageCursor: "",
            heartbeatAt: 0,
            heartbeatKeys: [],
            systemEpisodes: [],
            systemClaims: [],
            ...state,
          }),
        }),
        Layer.mock(Providers.ProviderRegistry)({ getProviders: catalog }),
        Settings.layerTest({
          d4Agent: { ...config, enabled: true, modelSelection: model },
        }),
        Layer.mock(Monitor.AgentMonitorReactor)({ snapshot: Effect.succeed([]) }),
      ),
    ),
  );
const layer = testLayer();
it.effect(
  "normal threads keep their provider path while the owned thread receives only a compact digest",
  () =>
    Effect.gen(function* () {
      const context = yield* Context.D4AgentContext;
      assert.equal(
        yield* context.prepare(ThreadId.make("ordinary"), { ...model, model: "different" }),
        null,
      );
      const prefix = yield* context.prepare(ownId, model);
      assert.isTrue(prefix?.startsWith("Current monitor digest:"));
      assert.isFalse(prefix?.includes("You are Nia"));
      assert.isTrue(prefix?.includes('"counts":{}'));
    }).pipe(Effect.provide(layer)),
);
it.effect("the normal composer cannot switch the owned thread away from the selected model", () =>
  Effect.gen(function* () {
    const context = yield* Context.D4AgentContext;
    for (const selection of [
      { ...model, model: "different" },
      { ...model, instanceId: ProviderInstanceId.make("different-provider") },
      { ...model, options: [{ id: "reasoning", value: "high" }] },
    ]) {
      const result = yield* Effect.result(context.prepare(ownId, selection));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "model-mismatch");
        assert.include(result.failure.message, "Nia model in Settings");
      }
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a background session receives its bound context without switching the visible session",
  () => {
    const personalId = ThreadId.make("personal-background");
    const sessions = [
      {
        context: "Personal" as const,
        threadId: personalId,
        providerSessionId: null,
        lastActivityAt: "2026-10-26T14:00:00Z",
        inputTokens: 0,
        contextWindow: null,
        scopeHash: contextScopeHash("Personal", DEFAULT_D4_AGENT_SETTINGS),
      },
    ];
    return Effect.gen(function* () {
      const context = yield* Context.D4AgentContext;
      assert.isTrue(yield* context.owns(personalId));
      const prefix = yield* context.prepare(personalId, model);
      assert.include(prefix ?? "", "Bound context: Personal");
      assert.notInclude(prefix ?? "", "Bound context: Global");
      assert.include((yield* context.prepare(ownId, model)) ?? "", "Bound context: Global");
    }).pipe(Effect.provide(testLayer({ sessions })));
  },
);
it.effect("source remapping rejects an old background session before model input", () => {
  const personalId = ThreadId.make("personal-background");
  const previous = { ...DEFAULT_D4_AGENT_SETTINGS, overviewSources: { mail: "Personal" as const } };
  const next = { ...previous, overviewSources: { mail: "Dimaggi" as const } };
  const sessions = [
    {
      context: "Personal" as const,
      threadId: personalId,
      providerSessionId: null,
      lastActivityAt: "2026-10-26T14:00:00Z",
      inputTokens: 0,
      contextWindow: null,
      scopeHash: contextScopeHash("Personal", previous),
    },
  ];
  return Effect.gen(function* () {
    const context = yield* Context.D4AgentContext;
    const result = yield* Effect.result(context.prepare(personalId, model));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "context");
  }).pipe(Effect.provide(testLayer({ sessions }, next)));
});

it.effect(
  "each owned turn receives current resource facts without account secrets or model catalog bloat",
  () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider]);
      yield* Effect.gen(function* () {
        const context = yield* Context.D4AgentContext;
        const before = yield* context.prepare(ownId, model);
        assert.notInclude(before ?? "", '"instanceId":"local-custom"');
        yield* Ref.update(catalog, (entries) => [
          ...entries,
          {
            ...provider,
            instanceId: ProviderInstanceId.make("local-custom"),
            enabled: false,
            auth: { status: "unknown" as const, email: "private-account" },
            models: [
              { slug: "unlisted-custom-model", name: "Custom", isCustom: true, capabilities: null },
            ],
          },
        ]);
        const after = yield* context.prepare(ownId, model);
        assert.include(after ?? "", '"instanceId":"local-custom"');
        assert.include(after ?? "", '"authentication":"unknown"');
        assert.include(after ?? "", '"available":false');
        assert.include(after ?? "", '"state":"unknown"');
        assert.include(after ?? "", '"modelCount":1');
        assert.notInclude(after ?? "", "private-account");
        assert.notInclude(after ?? "", "unlisted-custom-model");
        assert.equal(yield* context.prepare(ThreadId.make("ordinary"), model), null);
      }).pipe(Effect.provide(testLayer({}, DEFAULT_D4_AGENT_SETTINGS, Ref.get(catalog))));
    }),
);

it.effect("owned turns omit private endpoint diagnostics from provider snapshots", () =>
  Effect.gen(function* () {
    const diagnostic = "https://user:fake-secret@example.invalid/private-project";
    const snapshot: ServerProvider = {
      ...provider,
      ...buildServerProvider({
        presentation: { displayName: "OpenCode" },
        enabled: true,
        checkedAt: provider.checkedAt,
        models: provider.models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Could not reach ${diagnostic}`,
        },
      }),
      instanceId: ProviderInstanceId.make("private-endpoint"),
      driver: ProviderDriverKind.make("opencode"),
      unavailableReason: `Connection failed: ${diagnostic}`,
    };
    assert.include(snapshot.readiness?.remediation ?? "", diagnostic);
    yield* Effect.gen(function* () {
      const context = yield* Context.D4AgentContext;
      for (let turn = 0; turn < 2; turn++) {
        const serialized = (yield* context.prepare(ownId, model)) ?? "";

        assert.notInclude(serialized, "fake-secret");
        assert.notInclude(serialized, "example.invalid");
        assert.notInclude(serialized, "/private-project");
        assert.notInclude(serialized, "remediation");
        assert.include(serialized, '"available":false');
        assert.include(serialized, '"reachability":"failed"');
        assert.include(serialized, provider.checkedAt);
      }
    }).pipe(
      Effect.provide(
        testLayer({}, DEFAULT_D4_AGENT_SETTINGS, Effect.succeed([provider, snapshot])),
      ),
    );
  }),
);

it.effect("an unavailable configured model keeps its availability reason", () =>
  Effect.gen(function* () {
    const context = yield* Context.D4AgentContext;
    const result = yield* Effect.result(context.prepare(ownId, model));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "model-unavailable");
  }).pipe(
    Effect.provide(
      testLayer(
        {},
        DEFAULT_D4_AGENT_SETTINGS,
        Effect.succeed([
          { ...provider, models: [{ ...provider.models[0]!, slug: "other-model" }] },
        ]),
      ),
    ),
  ),
);
