import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import {
  DEFAULT_D4_AGENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentMonitorUpdate,
  type D4BrainContext,
  type ServerProvider,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as D4Handlers from "../mcp/toolkits/d4Agent/handlers.ts";
import { D4AgentToolkit } from "../mcp/toolkits/d4Agent/tools.ts";
import * as Agent from "./D4Agent.ts";
import * as Config from "../config.ts";
import * as Monitor from "../orchestration-v2/AgentMonitorReactor.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as AgentContext from "./D4AgentContext.ts";
import * as Store from "./D4AgentStore.ts";
import { contextScopeHash } from "./brainScope.ts";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "selected" };
const config = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  enabled: true,
  modelSelection: selection,
  projectContexts: {
    [ProjectId.make("work-a")]: "YB" as const,
    [ProjectId.make("work-b")]: "Dimaggi" as const,
  },
};
const provider: ServerProvider = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T12:00:00Z",
  models: [{ slug: selection.model, name: "Selected", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};
const updates: ReadonlyArray<AgentMonitorUpdate> = ["work-a", "work-b", "unmapped"].map((id) => ({
  threadId: ThreadId.make(`thread-${id}`),
  revision: 1,
  report: {
    schemaVersion: 1,
    runId: null,
    attemptId: null,
    classification: "needs_user",
    reason: "pending_request",
    attentionRequired: true,
    notificationEligible: true,
    reportKey: `marker-${id}`,
    observedAt: "2026-10-24T12:00:00Z",
    runStatus: null,
    pendingRequestId: null,
  },
}));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-scope-" });
  const storeLayer = Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory)));
  const store = yield* Store.D4AgentStore.pipe(Effect.provide(storeLayer));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES ('agent-project', ${store.workspace})`;
  for (const id of ["work-a", "work-b", "unmapped"])
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${`thread-${id}`}, ${id})`;
  const bindThread = Effect.fnUntraced(function* (context: D4BrainContext, id: string) {
    const threadId = ThreadId.make(id);
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId}, 'agent-project')`;
    yield* store.update((state) => ({
      ...state,
      threadId,
      projectId: ProjectId.make("agent-project"),
      brainContext: context,
      contextScopeHash: contextScopeHash(context, config),
      identityReady: true,
    }));
    return threadId;
  });
  const contextLayer = (source: Store.D4AgentStore["Service"]) =>
    AgentContext.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.D4AgentStore, source),
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
          Settings.layerTest({ d4Agent: config }),
          Layer.mock(Monitor.AgentMonitorReactor)({ snapshot: Effect.succeed(updates) }),
        ),
      ),
    );
  const service = yield* AgentContext.D4AgentContext.pipe(Effect.provide(contextLayer(store)));
  return { store, storeLayer, service, contextLayer, bindThread, sql };
});
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

it.effect(
  "work context digests exclude sibling and unmapped reports, while Global includes all",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const context of ["YB", "Dimaggi", "Global"] as const) {
          const threadId = yield* f.bindThread(context, `agent-${context}`);
          const prefix = yield* f.service.prepare(threadId, selection, `session-${context}`);
          assert.isString(prefix);
          assert.equal(prefix!.includes("marker-work-a"), context !== "Dimaggi");
          assert.equal(prefix!.includes("marker-work-b"), context !== "YB");
          assert.equal(prefix!.includes("marker-unmapped"), context === "Global");
          assert.include(prefix!, `Bound context: ${context}`);
        }
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "fresh conversations share a transport after restart but retired conversations remain refused",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const oldThread = yield* f.bindThread("YB", "old-agent");
        yield* f.service.prepare(oldThread, selection, "existing-provider-session");
        const newThread = yield* f.bindThread("Dimaggi", "new-agent");
        const reopened = yield* Store.D4AgentStore.pipe(Effect.provide(f.storeLayer));
        const service = yield* AgentContext.D4AgentContext.pipe(
          Effect.provide(f.contextLayer(reopened)),
        );
        assert.equal((yield* reopened.get).bindings.length, 1);
        const prefix = yield* service.prepare(newThread, selection, "existing-provider-session");
        assert.include(prefix!, "marker-work-b");
        assert.notInclude(prefix!, "marker-work-a");
        assert.equal((yield* reopened.get).bindings.length, 2);
        const old = yield* Effect.result(
          service.prepare(oldThread, selection, "existing-provider-session"),
        );
        assert.equal(old._tag, "Failure");
        if (old._tag === "Failure") assert.equal(old.failure.reason, "thread");
        assert.equal(yield* service.prepare(ThreadId.make("ordinary"), selection), null);
        yield* reopened.update((state) => ({
          ...state,
          brainContext: "YB",
          contextScopeHash: contextScopeHash("YB", config),
        }));
        for (const transport of ["existing-provider-session", "new-provider-transport"]) {
          const rebound = yield* Effect.result(service.prepare(newThread, selection, transport));
          assert.equal(rebound._tag, "Failure");
          if (rebound._tag === "Failure") {
            assert.equal(rebound.failure.reason, "context");
            assert.equal(
              rebound.failure.message,
              "Context operation refused; inspect the selected scope configuration.",
            );
            assert.isUndefined(rebound.failure.cause);
          }
        }
        assert.equal((yield* reopened.get).bindings.length, 2);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("changed scope configuration and failed project lookups refuse provider input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const threadId = yield* f.bindThread("YB", "agent");
      yield* f.store.update((state) => ({ ...state, contextScopeHash: "previous-mapping" }));
      const changed = yield* Effect.result(f.service.prepare(threadId, selection, "session"));
      assert.equal(changed._tag, "Failure");
      if (changed._tag === "Failure") assert.equal(changed.failure.reason, "context");
      assert.equal((yield* f.store.get).bindings.length, 0);
      yield* f.store.update((state) => ({
        ...state,
        contextScopeHash: contextScopeHash("YB", config),
      }));
      yield* f.sql`DROP TABLE orchestration_v2_projection_threads`;
      const failed = yield* Effect.result(f.service.prepare(threadId, selection, "session"));
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") {
        assert.equal(failed.failure.reason, "context");
        assert.isUndefined(failed.failure.cause);
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "MCP credentials use their own namespace and retired credentials cannot call agent tools",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const oldThread = yield* f.bindThread("YB", "old-agent");
        const transport = "provider-session:provider-instance:codex:shared";
        yield* f.service.prepare(oldThread, selection, transport);
        const threadId = yield* f.bindThread("Dimaggi", "new-agent");
        yield* f.service.prepare(threadId, selection, transport);
        const environmentId = EnvironmentId.make("isolated");
        const credentials = yield* McpProviderSessions.McpProviderSessions.pipe(
          Effect.provide(McpProviderSessions.layer),
        );
        const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1000 }).pipe(
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 1),
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(environmentId),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        );
        const issuedOld = yield* registry.issue({
          threadId: oldThread,
          providerInstanceId: selection.instanceId,
        });
        const issuedRetired = yield* registry.issue({
          threadId,
          providerInstanceId: selection.instanceId,
        });
        const issuedCurrent = yield* registry.issue({
          threadId,
          providerInstanceId: selection.instanceId,
        });
        yield* credentials.set(issuedCurrent.config);
        assert.notEqual(issuedCurrent.config.providerSessionId, transport);
        const toolkit = yield* D4AgentToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(D4Handlers.layer)),
        );
        for (const [issued, expectedFailure] of [
          [issuedCurrent, false],
          [issuedRetired, true],
          [issuedOld, true],
        ] as const) {
          const scope = yield* registry.resolve(
            issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          assert.isDefined(scope);
          const results = yield* toolkit
            .handle("d4_agent_system_health", {})
            .pipe(
              Effect.flatMap(Stream.runCollect),
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope!),
              Effect.provideService(Store.D4AgentStore, f.store),
              Effect.provideService(McpProviderSessions.McpProviderSessions, credentials),
              Effect.provide(Layer.mock(Agent.D4Agent)({ systemHealth: () => Effect.succeed([]) })),
            );
          assert.equal(results[0]?.isFailure, expectedFailure);
          if (expectedFailure)
            assert.equal(
              results[0]?.encodedResult,
              "Context operation refused; inspect the selected scope configuration.",
            );
        }
      }),
    ).pipe(Effect.provide(testLayer)),
);
