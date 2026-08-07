import * as Effect from "effect/Effect";

import { makeConfiguredMemoryConnector } from "./localConnector.ts";
import { MemoryToolkit } from "./tools.ts";

const getLocalConnector = makeConfiguredMemoryConnector;

const handlers = {
  memory_search: (input) =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).search(
        input.query,
        input.limit,
        input.project,
      );
      return { connector: "local" as const, results: result.results, count: result.results.length };
    }),
  memory_remember: (input) =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).add(
        input.text,
        input.source,
        input.project,
      );
      return {
        connector: "local" as const,
        ok: result.ok,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.hash === undefined ? {} : { hash: result.hash }),
      };
    }),
  memory_status: () =>
    Effect.gen(function* () {
      const result = yield* (yield* getLocalConnector()).health();
      return { connector: "local" as const, ...result };
    }),
} satisfies Parameters<typeof MemoryToolkit.toLayer>[0];

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(handlers);
