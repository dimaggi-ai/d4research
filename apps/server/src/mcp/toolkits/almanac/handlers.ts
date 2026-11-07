import * as Effect from "effect/Effect";

import * as Almanac from "../../../almanac/AlmanacService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AlmanacToolkit } from "./tools.ts";

export const AlmanacToolkitHandlersLive = McpToolAccess.toLayer(
  AlmanacToolkit,
  Effect.gen(function* () {
    const service = yield* Almanac.AlmanacService;
    return {
      almanac_search: McpToolAccess.reads((input) => service.search(input)),
      almanac_read: McpToolAccess.reads((input) => service.read(input)),
      almanac_recall: McpToolAccess.reads((input) => service.recall(input)),
      almanac_browse: McpToolAccess.reads((input) => service.browse(input)),
      almanac_remember: McpToolAccess.writesWithCapability((input) => service.remember(input)),
      almanac_update: McpToolAccess.writesWithCapability((input) => service.update(input)),
      almanac_forget: McpToolAccess.writesWithCapability((input) => service.forget(input)),
    } satisfies McpToolAccess.Handlers<typeof AlmanacToolkit.tools>;
  }),
);
