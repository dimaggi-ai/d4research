import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { withRelayClientTracing } from "@d4research/shared/relayTracing";

import { layerHeadlessRelayClient, layerServerRelayBroker } from "./relayTracing.ts";

vi.mock("./publicConfig.ts", () => ({
  resolveRelayClientTracingConfig: () => ({
    tracesUrl: "https://collector.example.test/v1/traces",
    tracesDataset: "server-traces",
    tracesToken: "test-ingest-token",
  }),
}));

it.effect.each([
  ["headless CLI", layerHeadlessRelayClient],
  ["environment server", layerServerRelayBroker],
] as const)("never exports %s spans despite configured collector credentials", ([, tracing]) => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const httpClient = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
  );
  const application = Layer.effectDiscard(
    Effect.void.pipe(Effect.withSpan("relay.connection.test"), withRelayClientTracing),
  ).pipe(Layer.provide(tracing), Layer.provide(httpClient));

  return Layer.build(application).pipe(
    Effect.scoped,
    Effect.andThen(Effect.sync(() => expect(fetchFn).not.toHaveBeenCalled())),
  );
});
