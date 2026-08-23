import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@d4research/client-runtime/rpc";

import { cryptoLayer } from "../connection/crypto";
import * as Persistence from "../persistence/layer";

const httpClientLayer = remoteHttpClientLayer(fetch);

type RuntimeLayerSource =
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof cryptoLayer
  | typeof httpClientLayer
  | typeof Persistence.layer;

const runtimeLayer = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  cryptoLayer,
  httpClientLayer,
  Persistence.layer,
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
