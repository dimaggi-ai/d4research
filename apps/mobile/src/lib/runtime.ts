import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { layerRemoteHttpClient } from "@d4research/client-runtime/rpc";

import * as NativeWebSocket from "../native/nativeWebSocket";
import { cryptoLayer } from "../connection/crypto";
import * as Persistence from "../persistence/layer";
import { whenProtectedDataAvailable } from "./protectedData";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const layerHttpClient = layerRemoteHttpClient(fetch);

type RuntimeLayerSource =
  | typeof NativeWebSocket.layer
  | typeof cryptoLayer
  | typeof layerHttpClient
  | typeof Persistence.layer;

const layerRuntime = Layer.mergeAll(
  NativeWebSocket.layer,
  cryptoLayer,
  layerHttpClient,
  Persistence.layer,
).pipe(Layer.provide(Layer.effectDiscard(Effect.promise(whenProtectedDataAvailable))));

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
