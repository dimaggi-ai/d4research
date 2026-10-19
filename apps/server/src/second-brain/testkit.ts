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
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "d4-brain-test-" });
      const dependencies = Layer.mergeAll(
        Files.layer,
        Index.layer,
        Embeddings.layer,
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
