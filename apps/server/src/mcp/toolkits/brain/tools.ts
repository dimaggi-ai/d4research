import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { SecondBrainError } from "../../../secondBrain.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

const dependencies = [FileSystem.FileSystem, Path.Path, ServerSettingsService];

const RelativePath = Schema.String.pipe(
  Schema.annotate({
    description:
      "Markdown file path relative to the second brain root, e.g. people/ivan-petrov.md.",
  }),
);

export const BrainMapOutput = Schema.Struct({
  root: Schema.String,
  mapFile: Schema.NullOr(Schema.String),
  map: Schema.String,
  files: Schema.Array(Schema.String),
});

export const BrainReadInput = Schema.Struct({ path: RelativePath });
export const BrainReadOutput = Schema.Struct({ path: Schema.String, content: Schema.String });

export const BrainSearchInput = Schema.Struct({
  query: Schema.String.pipe(
    Schema.annotate({ description: "Case-insensitive text matched against file names and lines." }),
  ),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)).pipe(
    Schema.withDecodingDefault(Effect.succeed(20)),
    Schema.annotate({ description: "Maximum matches to return. Defaults to 20." }),
  ),
});
export const BrainSearchOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.optional(Schema.Int),
      text: Schema.String,
    }),
  ),
  count: Schema.Int,
});

export const BrainWriteInput = Schema.Struct({
  path: RelativePath,
  content: Schema.String.pipe(Schema.annotate({ description: "Markdown to write." })),
  mode: Schema.Literals(["replace", "append"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("append")),
    Schema.annotate({
      description:
        "append (default) adds to the end of the file; replace overwrites the whole file. Either creates it.",
    }),
  ),
});
export const BrainWriteOutput = Schema.Struct({
  path: Schema.String,
  created: Schema.Boolean,
  bytes: Schema.Int,
});

const readonlyBrainTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const BrainMapTool = readonlyBrainTool(
  Tool.make("brain_map", {
    description:
      "Read the user's second brain: its AGENTS.md/CLAUDE.md map (with @file imports inlined) and every Markdown file in it. Call this first, follow the map's rules, and cite file paths in answers. If the answer is not in the brain, say so.",
    success: BrainMapOutput,
    failure: SecondBrainError,
    dependencies,
  }).annotate(Tool.Title, "Second brain map"),
);

export const BrainReadTool = readonlyBrainTool(
  Tool.make("brain_read", {
    description: "Read one Markdown file from the user's second brain.",
    parameters: BrainReadInput,
    success: BrainReadOutput,
    failure: SecondBrainError,
    dependencies,
  }).annotate(Tool.Title, "Read second brain file"),
);

export const BrainSearchTool = readonlyBrainTool(
  Tool.make("brain_search", {
    description:
      "Search the user's second brain by text. File-name matches come first, then matching lines with line numbers.",
    parameters: BrainSearchInput,
    success: BrainSearchOutput,
    failure: SecondBrainError,
    dependencies,
  }).annotate(Tool.Title, "Search second brain"),
);

export const BrainWriteTool = Tool.make("brain_write", {
  description:
    "Write to the user's second brain. Follow the map's rules: one topic per file, lowercase-hyphen names, update the existing topic file before creating a new one, absolute dates, never secrets.",
  parameters: BrainWriteInput,
  success: BrainWriteOutput,
  failure: SecondBrainError,
  dependencies,
})
  .annotate(Tool.Title, "Write second brain file")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const BrainToolkit = Toolkit.make(
  BrainMapTool,
  BrainReadTool,
  BrainSearchTool,
  BrainWriteTool,
);
