import * as Effect from "effect/Effect";

import {
  readSecondBrainFile,
  readSecondBrainMap,
  resolveSecondBrainRoot,
  searchSecondBrain,
  writeSecondBrainFile,
} from "../../../secondBrain.ts";
import { BrainToolkit } from "./tools.ts";

// The root is re-read per call so a Settings change applies to the next tool call.
const handlers = {
  brain_map: () => Effect.flatMap(resolveSecondBrainRoot(), readSecondBrainMap),
  brain_read: (input) =>
    Effect.flatMap(resolveSecondBrainRoot(), (root) => readSecondBrainFile(root, input.path)),
  brain_search: (input) =>
    Effect.gen(function* () {
      const results = yield* searchSecondBrain(
        yield* resolveSecondBrainRoot(),
        input.query,
        input.limit,
      );
      return { results, count: results.length };
    }),
  brain_write: (input) =>
    Effect.flatMap(resolveSecondBrainRoot(), (root) =>
      writeSecondBrainFile(root, input.path, input.content, input.mode),
    ),
} satisfies Parameters<typeof BrainToolkit.toLayer>[0];

export const BrainToolkitHandlersLive = BrainToolkit.toLayer(handlers);
