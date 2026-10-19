import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@d4research/client-runtime/rpc";

import { cryptoLayer } from "../connection/crypto";
import * as Persistence from "../persistence/layer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const layerHttpClient = layerRemoteHttpClient(fetch);

type RuntimeLayerSource =
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof cryptoLayer
  | typeof layerHttpClient
  | typeof Persistence.layer;

const layerRuntime = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  cryptoLayer,
  layerHttpClient,
  Persistence.layer,
);

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
