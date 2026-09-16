import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import { ObservabilityLive } from "./Observability.ts";

it.effect("keeps diagnostics local even with legacy external exporter settings", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const fetchFn = vi.fn<typeof fetch>();
    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    const legacyConfig = ServerConfig.layer({
      ...config,
      otlpTracesUrl: "https://collector.example.test/v1/traces",
      otlpMetricsUrl: "https://collector.example.test/v1/metrics",
      otlpExportIntervalMs: 1,
    });
    const observability = ObservabilityLive.pipe(
      Layer.provide(legacyConfig),
      Layer.provide(ResourceAttribution.layer),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    );

    // Closing the layer flushes both local files and any accidentally restored exporter.
    yield* Effect.void.pipe(
      Effect.withSpan("privacy-local-trace", { level: "Info" }),
      Effect.provide(observability),
      Effect.scoped,
    );

    assert.include(yield* fs.readFileString(config.serverTracePath), "privacy-local-trace");
    assert.equal(fetchFn.mock.calls.length, 0);
  }).pipe(
    Effect.provide(ServerConfig.layerTest("/workspace", { prefix: "d4-privacy-test-" })),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
