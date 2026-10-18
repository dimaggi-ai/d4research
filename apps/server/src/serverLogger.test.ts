// @effect-diagnostics preferSchemaOverJson:off - These tests construct and inspect raw JSON wire fixtures independently of production codecs.
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import { ExternalLauncherBrowserSpawnError } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestConsole from "effect/testing/TestConsole";

import { DEFAULT_SIGNAL_EXPORT } from "@d4research/shared/observability";
import * as OtelEnvironment from "@d4research/shared/otelEnvironment";

import * as ServerConfig from "./config.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ServerLogger from "./serverLogger.ts";
import {
  announceStartupPairingUrl,
  logBrowserAutoOpenUnavailable,
  maybeOpenBrowser,
} from "./serverRuntimeStartup.ts";

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const layerCollector = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const layerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "t3-server-logger-test");
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      return ServerConfig.make({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        cwd: baseDir,
        baseDir,
        ...derivedPaths,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 0,
        host: undefined,
        desktopBootstrapToken: undefined,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: false,
        startupPresentation: "browser",
        ...overrides,
      });
    }),
  ).pipe(Layer.provide(NodePath.layer));

/**
 * The export is asserted after the layer's scope closes, which is where the
 * exporter flushes whatever the interval did not.
 */
const logThrough = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    yield* Effect.log("server logger under test").pipe(
      Effect.provide(
        ServerLogger.layer.pipe(
          Layer.provide(layerConfig(overrides)),
          Layer.provide(layerCollector(requests)),
        ),
      ),
    );
    return requests;
  });

/**
 * Runs `program` (one log line by default) inside a span so the tracer logger
 * has somewhere to attach an event, then reports both what the collector
 * received and what landed on the span.
 */
const logInSpanThrough = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  program: Effect.Effect<void> = Effect.log("server logger under test"),
) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);
          return span;
        },
      }),
    );
    yield* program.pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(
        Layer.mergeAll(
          ServerLogger.layer.pipe(
            Layer.provide(layerConfig(overrides)),
            Layer.provide(layerCollector(requests)),
          ),
          layerTracer,
        ),
      ),
    );
    return { requests, spans };
  });

describe("ServerLoggerLive", () => {
  it.effect("ignores legacy external log exporter settings", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
        otlpLogsExport: {
          ...DEFAULT_SIGNAL_EXPORT,
          protocol: "http/protobuf",
          headers: { "x-scope": "logs" },
        },
      });

      assert.lengthOf(requests, 0);
    }),
  );

  it.effect("stays off the network when no logs endpoint is configured", () =>
    Effect.gen(function* () {
      const requests = yield* logThrough({});

      assert.lengthOf(requests, 0);
    }),
  );

  it.effect("attaches log messages to the active span when no logs endpoint is configured", () =>
    Effect.gen(function* () {
      const { requests, spans } = yield* logInSpanThrough({});

      assert.lengthOf(requests, 0);
      assert.lengthOf(spans, 1);
      assert.deepEqual(
        spans[0]?.events.map(([name]) => name),
        ["server logger under test"],
      );
    }),
  );

  it.effect("keeps attaching messages locally when legacy exporter settings are present", () =>
    Effect.gen(function* () {
      const { requests, spans } = yield* logInSpanThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
      });

      assert.lengthOf(requests, 0);
      assert.lengthOf(spans, 1);
      assert.deepEqual(
        spans[0]?.events.map(([name]) => name),
        ["server logger under test"],
      );
    }),
  );

  describe("startup pairing URL", () => {
    const pairingToken = "PAIRTOKEN7Q4K9";
    const pairingUrl = `http://localhost:3773/pair#token=${pairingToken}`;
    const announce = announceStartupPairingUrl(pairingUrl).pipe(
      Effect.andThen(logBrowserAutoOpenUnavailable),
    );

    it.effect("prints the full URL but keeps its token out of exported log records", () =>
      Effect.gen(function* () {
        const { requests, spans } = yield* logInSpanThrough(
          { otlpLogsUrl: "https://collector.example.com/v1/logs" },
          announce,
        );

        const body = requests.map((request) => request.body).join("\n");
        assert.lengthOf(requests, 0);
        assert.isTrue(
          spans.some((span) =>
            span.events.some(([name]) => name.includes("Authentication required")),
          ),
        );
        assert.notInclude(body, pairingToken);
        const printed = (yield* TestConsole.logLines).map((line) =>
          Array.isArray(line) ? line.join(" ") : String(line),
        );
        assert.isTrue(printed.some((line) => line.includes(`pairingUrl: ${pairingUrl}`)));
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token off the span events the trace file records", () =>
      Effect.gen(function* () {
        const { spans } = yield* logInSpanThrough({}, announce);

        const events = JSON.stringify(
          spans.flatMap((span) => span.events.map(([name, , attributes]) => [name, attributes])),
        );
        assert.include(events, "Authentication required");
        assert.notInclude(events, pairingToken);
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token out of traces when the browser fails to open", () =>
      Effect.gen(function* () {
        // A failed launch records its error, which names the target, on its span.
        const failingLaunch = maybeOpenBrowser(pairingUrl).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerConfig({ noBrowser: false }),
              Layer.mock(ExternalLauncher.ExternalLauncher)({
                launchBrowser: (target) =>
                  Effect.fail(
                    new ExternalLauncherBrowserSpawnError({
                      target,
                      command: "xdg-open",
                      args: [target],
                      cause: new Error("spawn xdg-open ENOENT"),
                    }),
                  ).pipe(Effect.withSpan("externalLauncher.launchBrowser")),
              }),
            ),
          ),
        );
        const { spans } = yield* logInSpanThrough({}, failingLaunch);

        const recorded = JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            events: span.events.map(([name, , attributes]) => [name, attributes]),
            exit:
              span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
                ? Cause.pretty(span.status.exit.cause)
                : null,
          })),
        );
        assert.include(recorded, "browser auto-open unavailable");
        assert.notInclude(recorded, pairingToken);
      }),
    );
  });
});
