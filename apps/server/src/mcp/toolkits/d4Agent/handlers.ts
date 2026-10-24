import { D4AgentError } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Agent from "../../../d4Agent/D4Agent.ts";
import * as AgentContext from "../../../d4Agent/D4AgentContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { D4AgentToolkit } from "./tools.ts";
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const context = yield* AgentContext.D4AgentContext;
  if (scope.thread === undefined || !(yield* context.owns(scope.thread.threadId)))
    return yield* new D4AgentError({ reason: "action-unavailable" });
  return yield* Agent.D4Agent;
});
export const layer = McpToolAccess.toLayer(D4AgentToolkit, {
  d4_agent_list: McpToolAccess.reads(() =>
    caller.pipe(Effect.flatMap((service) => service.list())),
  ),
  d4_agent_read_tail: McpToolAccess.reads(({ threadId, limit }) =>
    caller.pipe(Effect.flatMap((service) => service.readTail(threadId, limit ?? 10))),
  ),
  d4_agent_system_health: McpToolAccess.reads(() =>
    caller.pipe(Effect.flatMap((service) => service.systemHealth())),
  ),
  // The d4 service owns the per-action approval gate; generic orchestration access would bypass it.
  d4_agent_action: McpToolAccess.reads(({ action }) =>
    caller.pipe(Effect.flatMap((service) => service.requestAction(action))),
  ),
});
