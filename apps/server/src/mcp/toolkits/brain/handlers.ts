import * as Effect from "effect/Effect";
import * as SecondBrainService from "../../../second-brain/SecondBrainService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BrainToolkit } from "./tools.ts";

const actor = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map(
    (scope) => scope.thread?.threadId ?? scope.client?.sessionId ?? scope.requestNamespace,
  ),
);
export const BrainToolkitHandlersLive = McpToolAccess.toLayer(
  BrainToolkit,
  Effect.gen(function* () {
    const service = yield* SecondBrainService.SecondBrainService;
    return {
      brain_status: McpToolAccess.reads(() => service.status()),
      brain_map: McpToolAccess.reads(() => service.map()),
      brain_read: McpToolAccess.reads((input) => service.read(input)),
      brain_search: McpToolAccess.reads((input) => service.search(input)),
      brain_backlinks: McpToolAccess.reads((input) => service.backlinks(input.path)),
      brain_propose: McpToolAccess.writesWithCapability((input) =>
        Effect.flatMap(actor, (id) => service.propose(input, id)),
      ),
      brain_proposals: McpToolAccess.reads((input) =>
        Effect.flatMap(actor, (id) => service.listProposals(input, id)),
      ),
      brain_write: McpToolAccess.writesWithCapability((input) =>
        Effect.flatMap(actor, (id) => service.write(input, id)),
      ),
      brain_lint: McpToolAccess.reads(() => service.lint()),
      brain_reindex: McpToolAccess.writesWithCapability(() => service.reindex()),
    } satisfies McpToolAccess.Handlers<typeof BrainToolkit.tools>;
  }),
);
