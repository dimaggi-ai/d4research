import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export type MemoryConnector = "local" | "meko";

export class MemoryConnectorError extends Schema.TaggedErrorClass<MemoryConnectorError>()(
  "MemoryConnectorError",
  {
    connector: Schema.Literals(["local", "meko"]),
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const MemoryEntry = Schema.Struct({
  id: Schema.optional(Schema.String),
  text: Schema.String,
  score: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Unknown),
});
export type MemoryEntry = typeof MemoryEntry.Type;

export const MemorySearchResult = Schema.Struct({ results: Schema.Array(MemoryEntry) });
export type MemorySearchResult = typeof MemorySearchResult.Type;

export const MemoryStats = Schema.Struct({
  count: Schema.optional(Schema.Number),
  backend: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  extra: Schema.optional(Schema.Unknown),
});
export type MemoryStats = typeof MemoryStats.Type;

export const MemoryAddResult = Schema.Struct({
  id: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String),
  ok: Schema.Boolean,
});
export type MemoryAddResult = typeof MemoryAddResult.Type;

export const DEFAULT_LOCAL_MEMO_BASE_URL = "http://127.0.0.1:8099";
export const DEFAULT_MEKO_MCP_URL = "https://mcp.mekodata.ai/mcp";
export const DEFAULT_MEMORY_TIMEOUT_MS = 10_000;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringField = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "string" ? record[key] : undefined;

const numberField = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "number" ? record[key] : undefined;

const booleanField = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "boolean" ? record[key] : undefined;

const connectorError = (connector: MemoryConnector, operation: string, cause: unknown) =>
  new MemoryConnectorError({
    connector,
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const requestJson = (
  client: HttpClient.HttpClient,
  connector: MemoryConnector,
  operation: string,
  request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>,
  timeoutMs: number,
) =>
  request.pipe(
    Effect.flatMap(client.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
    Effect.timeout(timeoutMs),
    Effect.mapError((cause) => connectorError(connector, operation, cause)),
  );

const normalizeEntry = (value: unknown): MemoryEntry | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const text = stringField(record, "text") ?? stringField(record, "memory");
  if (!text) return undefined;
  const id = stringField(record, "id");
  const score = numberField(record, "score");
  return {
    text,
    ...(id === undefined ? {} : { id }),
    ...(score === undefined ? {} : { score }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
  };
};

const normalizeSearch = (value: unknown): MemorySearchResult => {
  const record = asRecord(value);
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record?.results)
      ? record.results
      : [];
  return { results: candidates.map(normalizeEntry).filter((entry) => entry !== undefined) };
};

const normalizeStats = (value: unknown, fallbackStatus = "ok"): MemoryStats => {
  const record = asRecord(value);
  if (!record) return { status: fallbackStatus };
  const count = numberField(record, "count") ?? numberField(record, "chunks");
  const backend = stringField(record, "backend");
  const status =
    stringField(record, "status") ?? (booleanField(record, "ok") ? "ok" : fallbackStatus);
  return {
    status,
    ...(count === undefined ? {} : { count }),
    ...(backend === undefined ? {} : { backend }),
    extra: value,
  };
};

const normalizeAdd = (value: unknown): MemoryAddResult => {
  const record = asRecord(value);
  if (!record) return { ok: true };
  const id = stringField(record, "id");
  const hash = stringField(record, "hash");
  return {
    ok: booleanField(record, "ok") ?? (id !== undefined || hash !== undefined),
    ...(id === undefined ? {} : { id }),
    ...(hash === undefined ? {} : { hash }),
  };
};

export interface LocalMemoConfig {
  readonly baseUrl: string;
  readonly project?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface LocalMemoConnector {
  readonly search: (
    query: string,
    k: number,
    project?: string,
  ) => Effect.Effect<MemorySearchResult, MemoryConnectorError>;
  readonly getById: (id: string) => Effect.Effect<never, MemoryConnectorError>;
  readonly add: (
    text: string,
    source?: string,
    project?: string,
  ) => Effect.Effect<MemoryAddResult, MemoryConnectorError>;
  readonly stats: () => Effect.Effect<MemoryStats, MemoryConnectorError>;
  readonly health: () => Effect.Effect<MemoryStats, MemoryConnectorError>;
}

export const makeLocalMemoConnector = Effect.fn("memory.makeLocalMemoConnector")(function* (
  config: LocalMemoConfig,
): Effect.fn.Return<LocalMemoConnector, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_MEMORY_TIMEOUT_MS;

  const get = (
    operation: string,
    path: string,
    params?: Readonly<Record<string, string | number | undefined>>,
  ) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && String(value).length > 0) url.searchParams.set(key, String(value));
    }
    return requestJson(
      client,
      "local",
      operation,
      Effect.succeed(HttpClientRequest.get(url)),
      timeoutMs,
    );
  };

  return {
    search: (query, k, project) =>
      get("search", "/search", { q: query, k, project: project ?? config.project }).pipe(
        Effect.map(normalizeSearch),
      ),
    getById: () =>
      Effect.fail(
        new MemoryConnectorError({
          connector: "local",
          operation: "get",
          message: "Local Memo does not support keyed retrieval. Use memory_search instead.",
        }),
      ),
    add: (text, source, project) =>
      requestJson(
        client,
        "local",
        "add",
        HttpClientRequest.post(`${baseUrl}/add`).pipe(
          HttpClientRequest.bodyJson({
            text,
            source: source ?? "t3code",
            project: project ?? config.project,
          }),
        ),
        timeoutMs,
      ).pipe(Effect.map(normalizeAdd)),
    stats: () => get("stats", "/stats").pipe(Effect.map((value) => normalizeStats(value))),
    health: () => get("health", "/health").pipe(Effect.map((value) => normalizeStats(value))),
  };
});

export interface MekoConfig {
  readonly mcpUrl: string;
  readonly authorization: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly agentId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface MekoConnector {
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<MemorySearchResult, MemoryConnectorError>;
  readonly getById: (id: string) => Effect.Effect<MemoryEntry, MemoryConnectorError>;
  readonly add: (
    text: string,
    metadata?: unknown,
  ) => Effect.Effect<MemoryAddResult, MemoryConnectorError>;
  readonly status: () => Effect.Effect<MemoryStats, MemoryConnectorError>;
}

const decodeMcpText = (value: unknown) => {
  const record = asRecord(value);
  const structured = record?.structuredContent;
  if (structured !== undefined) return Effect.succeed(structured);
  const content = record?.content;
  if (!Array.isArray(content)) return Effect.succeed(value);
  const text = content
    .map(asRecord)
    .find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  return text === undefined
    ? Effect.succeed(value)
    : Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
        Effect.orElseSucceed(() => ({ text })),
      );
};

export const makeMekoConnector = Effect.fn("memory.makeMekoConnector")(function* (
  config: MekoConfig,
): Effect.fn.Return<MekoConnector, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const timeoutMs = config.timeoutMs ?? DEFAULT_MEMORY_TIMEOUT_MS;
  let requestId = 0;

  const call = (operation: string, name: string, args: Readonly<Record<string, unknown>>) =>
    requestJson(
      client,
      "meko",
      operation,
      HttpClientRequest.post(config.mcpUrl).pipe(
        HttpClientRequest.setHeader("Authorization", config.authorization),
        HttpClientRequest.setHeader("Accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJson({
          jsonrpc: "2.0",
          id: ++requestId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ),
      timeoutMs,
    ).pipe(
      Effect.flatMap((raw) => {
        const record = asRecord(raw);
        const error = asRecord(record?.error);
        if (!error) return decodeMcpText(record?.result ?? raw);
        return Effect.fail(
          new MemoryConnectorError({
            connector: "meko",
            operation,
            message: stringField(error, "message") ?? "Meko returned a JSON-RPC error.",
          }),
        );
      }),
    );

  const common = {
    conversation_id: config.conversationId,
    run_id: config.runId,
    agent_id: config.agentId ?? "t3code",
  };

  const getById: MekoConnector["getById"] = (id) =>
    call("get", "memory_get_by_id", { ...common, scope: "read", memory_id: id, id }).pipe(
      Effect.flatMap((value) => {
        const entry = normalizeEntry(asRecord(value)?.result ?? value);
        return entry
          ? Effect.succeed(entry)
          : Effect.fail(
              new MemoryConnectorError({
                connector: "meko",
                operation: "get",
                message: `Meko did not return memory ${id}.`,
              }),
            );
      }),
    );

  return {
    search: (query, limit) =>
      call("search", "memory_search", { ...common, scope: "read", query, limit }).pipe(
        Effect.map(normalizeSearch),
      ),
    getById,
    add: (text, metadata) =>
      call("add", "memory_add", {
        ...common,
        scope: "write",
        text,
        ...(metadata === undefined ? {} : { metadata }),
      }).pipe(
        Effect.map(normalizeAdd),
        Effect.flatMap((added) =>
          added.id === undefined
            ? Effect.fail(
                new MemoryConnectorError({
                  connector: "meko",
                  operation: "verify_write",
                  message: "Meko did not return an id for the stored memory.",
                }),
              )
            : getById(added.id).pipe(Effect.as(added)),
        ),
      ),
    status: () =>
      call("status", "memory_search", {
        ...common,
        scope: "read",
        query: "t3code connector health",
        limit: 1,
      }).pipe(Effect.map((value) => ({ status: "ok", extra: value }))),
  };
});
