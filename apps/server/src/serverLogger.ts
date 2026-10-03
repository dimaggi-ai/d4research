import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import * as ServerConfig from "./config.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  // `Logger.layer` writes the whole logger set rather than adding to it, so
  // every logger the server wants has to be named in this one call.
  const loggerLayer = Logger.layer([Logger.consolePretty(), Logger.tracerLogger], {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
