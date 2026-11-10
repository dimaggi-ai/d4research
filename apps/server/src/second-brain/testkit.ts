import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import { type SecondBrainSettings } from "@d4research/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as Files from "./SecondBrainFiles.ts";
import * as Index from "./SecondBrainIndex.ts";
import * as Embeddings from "./SecondBrainEmbeddings.ts";
import * as Kumbuka from "./KumbukaBrain.ts";
import * as Service from "./SecondBrainService.ts";

export function withBrain<A, E, R>(
  body: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    | R
    | Service.SecondBrainService
    | Files.SecondBrainFiles
    | Index.SecondBrainIndex
    | ServerSettingsService
    | FileSystem.FileSystem
    | Scope.Scope
  >,
  overrides: Partial<SecondBrainSettings> = {},
  kumbuka: Layer.Layer<Kumbuka.KumbukaBrain> = Kumbuka.layerDisabled,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Index fixtures must use the same canonical vault key as SecondBrainFiles.root.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "d4-brain-test-" })
        .pipe(Effect.flatMap((path) => fs.realPath(path)));
      const dependencies = Layer.mergeAll(
        Files.layer,
        Index.layer,
        Embeddings.layer,
        kumbuka,
        ServerSettingsService.layerTest({
          secondBrain: { path: root, generateIndex: false, ...overrides },
        }),
      );
      return yield* body(root).pipe(
        Effect.provide(
          Service.layer.pipe(
            Layer.provideMerge(dependencies),
            Layer.provide(ServerConfig.layerTest(root, { prefix: "d4-brain-state-" })),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}
