import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeLocalMemoConnector, makeMekoConnector, MemoryConnectorError } from "./connectors.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const fakeHttpLayer = (respond: (request: HttpClientRequest.HttpClientRequest) => unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(respond(request)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );

describe("local Memo connector", () => {
  it.effect("maps search parameters and normalizes Memo memories", () => {
    let requestedParams: ReadonlyArray<readonly [string, string]> = [];
    return Effect.gen(function* () {
      const connector = yield* makeLocalMemoConnector({ baseUrl: "http://127.0.0.1:8099" });
      const result = yield* connector.search("voice preferences", 3, "t3code");
      expect(requestedParams).toContainEqual(["q", "voice preferences"]);
      expect(requestedParams).toContainEqual(["k", "3"]);
      expect(requestedParams).toContainEqual(["project", "t3code"]);
      expect(result.results[0]).toMatchObject({ id: "memo-1", text: "Keep replies concise" });
    }).pipe(
      Effect.provide(
        fakeHttpLayer((request) => {
          requestedParams = request.urlParams.params;
          return { results: [{ id: "memo-1", memory: "Keep replies concise", score: 0.9 }] };
        }),
      ),
    );
  });

  it.effect("sends explicit add requests", () => {
    let method = "";
    return Effect.gen(function* () {
      const connector = yield* makeLocalMemoConnector({ baseUrl: "http://127.0.0.1:8099" });
      const result = yield* connector.add("Remember this", "t3code", "project-a");
      expect(method).toBe("POST");
      expect(result).toEqual({ id: "memo-2", ok: true });
    }).pipe(
      Effect.provide(
        fakeHttpLayer((request) => {
          method = request.method;
          return { id: "memo-2", ok: true };
        }),
      ),
    );
  });

  it.effect("explains that keyed get is unsupported", () =>
    Effect.gen(function* () {
      const connector = yield* makeLocalMemoConnector({ baseUrl: "http://127.0.0.1:8099" });
      const error = yield* connector.getById("missing").pipe(Effect.flip);
      expect(error).toBeInstanceOf(MemoryConnectorError);
      expect(error.message).toContain("memory_search");
    }).pipe(Effect.provide(fakeHttpLayer(() => ({})))),
  );
});

describe("hosted Meko connector", () => {
  const config = {
    mcpUrl: "https://mcp.mekodata.ai/mcp",
    authorization: "Bearer test-token",
    conversationId: "123456781234123412341234567890ab",
    runId: "12345678-1234-1234-1234-1234567890ab",
  };

  it.effect("uses verified Meko tool names and keyed readback after write", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const connector = yield* makeMekoConnector(config);
      const result = yield* connector.add("Remember this");
      expect(result).toEqual({ id: "meko-1", ok: true });
      expect(calls).toEqual(["memory_add", "memory_get_by_id"]);
    }).pipe(
      Effect.provide(
        fakeHttpLayer((request) => {
          const body = request.body;
          const decoded =
            body._tag === "Uint8Array"
              ? Schema.decodeSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(body.body))
              : undefined;
          const name =
            typeof decoded === "object" && decoded !== null && "params" in decoded
              ? (decoded.params as { name?: string }).name
              : undefined;
          if (name) calls.push(name);
          return name === "memory_add"
            ? { jsonrpc: "2.0", id: 1, result: { structuredContent: { id: "meko-1", ok: true } } }
            : {
                jsonrpc: "2.0",
                id: 2,
                result: { structuredContent: { id: "meko-1", memory: "Remember this" } },
              };
        }),
      ),
    );
  });

  it.effect("surfaces JSON-RPC errors without exposing authorization", () =>
    Effect.gen(function* () {
      const connector = yield* makeMekoConnector(config);
      const error = yield* connector.search("anything", 5).pipe(Effect.flip);
      expect(error.message).toBe("quota exceeded");
      expect(error.message).not.toContain("test-token");
    }).pipe(
      Effect.provide(
        fakeHttpLayer(() => ({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "quota exceeded" },
        })),
      ),
    ),
  );
});
