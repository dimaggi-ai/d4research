import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  DEFAULT_LOCAL_MEMO_BASE_URL,
  MemoryConnectorError,
  makeLocalMemoConnector,
  type LocalMemoConnector,
} from "./connectors.ts";
import { makeBuiltinMemoryConnector } from "./builtinStore.ts";

export const BUILTIN_MEMORY_FILENAME = "memory.sqlite";

/**
 * The one place that turns memory settings into a live connector, shared by
 * the MCP memory tools, the handoff routes, and research delegation. The
 * `builtin` backend is the in-server SQLite store; `memo-rest` (or the
 * T3CODE_LOCAL_MEMO_URL escape hatch) talks to an external Memo server.
 */
export const makeConfiguredMemoryConnector = Effect.fn("memory.makeConfiguredConnector")(
  function* (): Effect.fn.Return<
    LocalMemoConnector,
    MemoryConnectorError,
    HttpClient.HttpClient | ServerSettingsService | ServerConfig.ServerConfig | Path.Path
  > {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(
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
    if (!settings.memory.localEnabled) {
      return yield* new MemoryConnectorError({
        connector: "local",
        operation: "configure",
        message: "Local shared memory is disabled in Settings → Connections.",
      });
    }
    const envUrl = process.env.T3CODE_LOCAL_MEMO_URL;
    if (settings.memory.localBackend === "memo-rest" || envUrl !== undefined) {
      return yield* makeLocalMemoConnector({
        baseUrl: envUrl ?? settings.memory.localBaseUrl ?? DEFAULT_LOCAL_MEMO_BASE_URL,
      });
    }
    const config = yield* ServerConfig.ServerConfig;
    const { join } = yield* Path.Path;
    return makeBuiltinMemoryConnector(join(config.stateDir, BUILTIN_MEMORY_FILENAME));
  },
);
