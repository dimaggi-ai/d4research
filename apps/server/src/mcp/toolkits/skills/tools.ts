import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

const dependencies = [FileSystem.FileSystem, Path.Path];

export const SkillsSearchInput = Schema.Struct({
  query: Schema.String.pipe(
    Schema.annotate({
      description:
        "Substring matched against skill names and descriptions. Empty returns every skill.",
    }),
  ),
  limit: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(10)),
    Schema.annotate({ description: "Maximum results to return. Defaults to 10." }),
  ),
});
export type SkillsSearchInput = typeof SkillsSearchInput.Type;

export const SkillsSearchResult = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Absolute instruction-file path: read it to get the instructions. */
  path: Schema.String,
  root: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  agents: Schema.Array(Schema.String),
});
export type SkillsSearchResult = typeof SkillsSearchResult.Type;

export const SkillsSearchOutput = Schema.Struct({
  results: Schema.Array(SkillsSearchResult),
  count: Schema.Int,
});
export type SkillsSearchOutput = typeof SkillsSearchOutput.Type;

const SkillsSearchTool = Tool.make("skills_search", {
  description:
    "Search local agent skills and commands installed on this machine. Scans the filesystem on each call. Returns each entry's absolute instruction-file path; read that file to get its instructions. This tool does not execute skills or commands.",
  parameters: SkillsSearchInput,
  success: SkillsSearchOutput,
  dependencies,
})
  .annotate(Tool.Title, "Search skills")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SkillsToolkit = Toolkit.make(SkillsSearchTool);
