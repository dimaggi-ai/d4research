import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeLocalMemoConnector } from "./connectors.ts";

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
});
