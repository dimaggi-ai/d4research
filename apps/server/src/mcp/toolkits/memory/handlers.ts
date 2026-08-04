import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  DEFAULT_LOCAL_MEMO_BASE_URL,
  DEFAULT_MEKO_MCP_URL,
  MemoryConnectorError,
  makeLocalMemoConnector,
  makeMekoConnector,
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

const getMekoConnector = Effect.fn("memory.getMekoConnector")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
) {
  const settings = yield* getMemorySettings();
  if (!settings.mekoEnabled) {
    return yield* new MemoryConnectorError({
      connector: "meko",
      operation: "configure",
      message: "Meko is disabled in Settings → Connections.",
    });
  }
  const authorization = process.env.T3CODE_MEKO_AUTHORIZATION;
  if (!authorization) {
    return yield* new MemoryConnectorError({
      connector: "meko",
      operation: "configure",
      message: "Meko requires T3CODE_MEKO_AUTHORIZATION in the T3 server environment.",
    });
  }
  const threadId = String(invocation.threadId);
  return yield* makeMekoConnector({
    mcpUrl: process.env.T3CODE_MEKO_MCP_URL ?? settings.mekoMcpUrl ?? DEFAULT_MEKO_MCP_URL,
    authorization,
    conversationId: threadId.replaceAll("-", ""),
    runId: threadId,
    agentId: String(invocation.providerInstanceId),
  });
});

const handlers = {
  memory_search: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (input.connector === "local") {
        const result = yield* (yield* getLocalConnector()).search(
          input.query,
          input.limit,
          input.project,
        );
        return {
          connector: "local" as const,
          results: result.results,
          count: result.results.length,
        };
      }
      const result = yield* (yield* getMekoConnector(invocation)).search(input.query, input.limit);
      return { connector: "meko" as const, results: result.results, count: result.results.length };
    }),
  memory_remember: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const result =
        input.connector === "local"
          ? yield* (yield* getLocalConnector()).add(input.text, input.source, input.project)
          : yield* (yield* getMekoConnector(invocation)).add(input.text, input.metadata);
      return {
        connector: input.connector,
        ok: result.ok,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.hash === undefined ? {} : { hash: result.hash }),
      };
    }),
  memory_get: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      return input.connector === "local"
        ? yield* (yield* getLocalConnector()).getById(input.id)
        : yield* (yield* getMekoConnector(invocation)).getById(input.id);
    }),
  memory_status: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (input.connector === "local") {
        const result = yield* (yield* getLocalConnector()).health();
        return { connector: "local" as const, ...result };
      }
      const result = yield* (yield* getMekoConnector(invocation)).status();
      return { connector: "meko" as const, ...result };
    }),
} satisfies Parameters<typeof MemoryToolkit.toLayer>[0];

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(handlers);
