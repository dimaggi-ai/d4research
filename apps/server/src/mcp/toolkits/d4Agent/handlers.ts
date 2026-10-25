import { D4AgentError } from "@d4research/contracts";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Agent from "../../../d4Agent/D4Agent.ts";
import * as AgentStore from "../../../d4Agent/D4AgentStore.ts";
import * as AgentAccess from "../../../d4Agent/D4AgentAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { D4AgentToolkit } from "./tools.ts";
const call = <A>(run: (service: Agent.D4Agent["Service"]) => Effect.Effect<A, D4AgentError>) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const store = yield* Effect.serviceOption(AgentStore.D4AgentStore);
    if (Option.isNone(store)) return yield* new D4AgentError({ reason: "context" });
    const state = yield* store.value.get;
    // MCP credential IDs are per-thread bearer identities, separate from shared provider transports.
    const sessions = yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions);
    const credential =
      scope.thread === undefined || Option.isNone(sessions)
        ? undefined
        : yield* sessions.value.read(scope.thread.threadId);
    if (
      scope.thread === undefined ||
      scope.thread.threadId !== state.threadId ||
      credential === undefined ||
      credential.providerSessionId !== scope.thread.providerSessionId ||
      credential.providerInstanceId !== scope.thread.providerInstanceId ||
      !state.bindings.some(
        (entry) => entry.threadId === state.threadId && entry.context === state.brainContext,
      )
    )
      return yield* new D4AgentError({ reason: "context" });
    const service = yield* Agent.D4Agent;
    return yield* run(service).pipe(
      Effect.provideService(AgentAccess.ToolCaller, scope.thread.threadId),
    );
  }).pipe(Effect.mapError((error) => error.message));
export const layer = McpToolAccess.toLayer(D4AgentToolkit, {
  d4_agent_resolve: McpToolAccess.reads(({ text }) =>
    call((service) => service.resolveReference(text)),
  ),
  d4_agent_pipelines: McpToolAccess.reads(() => call((service) => service.listPipelines())),
  d4_agent_research: McpToolAccess.writesWithCapability((input) =>
    call((service) => service.requestAction({ ...input, type: "research" })),
  ),
  d4_agent_pipeline: McpToolAccess.writesWithCapability((input) =>
    call((service) => service.requestAction({ ...input, type: "pipeline" })),
  ),
  d4_agent_list: McpToolAccess.reads(() => call((service) => service.list())),
  d4_agent_environment: McpToolAccess.reads(() => call((service) => service.environment())),
  d4_agent_read_tail: McpToolAccess.reads(({ threadId, limit }) =>
    call((service) => service.readTail(threadId, limit ?? 10)),
  ),
  d4_agent_system_health: McpToolAccess.reads(() => call((service) => service.systemHealth())),
  // The d4 service owns the approval gate and rechecks it when approval is resolved.
  d4_agent_action: McpToolAccess.writesWithCapability(({ action }) =>
    call((service) => service.requestAction(action)),
  ),
  d4_agent_memory_search: McpToolAccess.reads((input) =>
    call((service) => service.memorySearch(input)),
  ),
  d4_agent_memory_read: McpToolAccess.reads((input) =>
    call((service) => service.memoryRead(input)),
  ),
  d4_agent_memory_propose: McpToolAccess.writesWithCapability((input) =>
    call((service) => service.requestAction({ type: "memory-propose", ...input })),
  ),
  d4_agent_cto_status: McpToolAccess.reads((input) =>
    call((service) => service.ctoRead({ ...input, operation: "status" })),
  ),
  d4_agent_cto_brief: McpToolAccess.reads((input) =>
    call((service) => service.ctoRead({ ...input, operation: "brief" })),
  ),
  d4_agent_cto_ask: McpToolAccess.writesWithCapability((input) =>
    call((service) => service.requestAction({ type: "cto-ask", ...input })),
  ),
});
