import * as Effect from "effect/Effect";

import { searchMemoAttachment } from "../../../memoAttachment.ts";
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
  memory_attachment_search: (input) =>
    Effect.gen(function* () {
      const memoConnector = yield* getLocalConnector();
      const searched = yield* searchMemoAttachment({
        connector: memoConnector,
        documentToken: input.documentToken,
        query: input.query,
        limit: input.limit,
        ...(input.project === undefined ? {} : { project: input.project }),
      });
      return {
        connector: "local" as const,
        documentToken: input.documentToken,
        status: searched.status,
        results: searched.results,
        count: searched.results.length,
      };
    }),
} satisfies Parameters<typeof MemoryToolkit.toLayer>[0];

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(handlers);
