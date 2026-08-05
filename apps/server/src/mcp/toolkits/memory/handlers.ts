import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  DEFAULT_LOCAL_MEMO_BASE_URL,
  MemoryConnectorError,
  makeLocalMemoConnector,
} from "./connectors.ts";
import { MemoryToolkit } from "./tools.ts";

const getMemorySettings = Effect.fn("memory.getSettings")(function* () {
  const service = yield* ServerSettingsService;
  return yield* service.getSettings.pipe(
    Effect.map((settings) => settings.memory),
    Effect.mapError(
      (cause) =>
        new MemoryConnectorError({
          connector: "local",
          operation: "configure",
          message: "Could not read memory connector settings.",
          cause,
        }),
    ),
  );
});

const getLocalConnector = Effect.fn("memory.getLocalConnector")(function* () {
  const settings = yield* getMemorySettings();
  if (!settings.localEnabled) {
    return yield* new MemoryConnectorError({
      connector: "local",
      operation: "configure",
      message: "Local Memo is disabled in Settings → Connections.",
    });
  }
  return yield* makeLocalMemoConnector({
    baseUrl:
      process.env.T3CODE_LOCAL_MEMO_URL ?? settings.localBaseUrl ?? DEFAULT_LOCAL_MEMO_BASE_URL,
  });
});

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
