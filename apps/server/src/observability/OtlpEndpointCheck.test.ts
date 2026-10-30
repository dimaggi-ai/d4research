import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as OtlpEndpointCheck from "./OtlpEndpointCheck.ts";

it.effect.each(["traces", "metrics", "logs"] as const)(
  "keeps %s probes disabled without sending URLs or credentials",
  (signal) => {
    const requests: string[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
    });
    return Effect.gen(function* () {
      const service = yield* OtlpEndpointCheck.OtlpEndpointCheck;
      const result = yield* service.check({
        signal,
        url: `https://collector.example.com/v1/${signal}?token=query-secret`,
      });
      assert.deepStrictEqual(result, { _tag: "Unreachable", timedOut: false });
      assert.deepStrictEqual(requests, []);
    }).pipe(
      Effect.provide(
        Layer.merge(OtlpEndpointCheck.layer, Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );
  },
);
