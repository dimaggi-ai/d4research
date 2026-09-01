import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  RESEARCH_PIPELINE_PROMPT_MAX_CHARS,
  RESEARCH_PROMPT_FILE_MAX_COUNT,
  ResearchPromptFile,
  RESEARCH_SCENARIO_NAME_REGEX,
} from "@d4research/contracts";
import { ServerSettingsService } from "../../../serverSettings.ts";

const dependencies = [ServerSettingsService];
export const PipelineKind = Schema.Literals(["dev", "research"]);

const PipelineSelector = Schema.Struct({
  kind: PipelineKind.pipe(Schema.annotate({ description: "Pipeline namespace: dev or research." })),
  name: Schema.String.check(Schema.isPattern(RESEARCH_SCENARIO_NAME_REGEX)).pipe(
    Schema.annotate({ description: "Scenario name, as used by !dev:<name> or !research:<name>." }),
  ),
});

const PipelineScenario = Schema.Struct({
  kind: PipelineKind,
  name: Schema.String,
  pipelinePrompt: Schema.String,
  promptFiles: Schema.Array(ResearchPromptFile),
  active: Schema.Boolean,
  trigger: Schema.String,
});

const PipelineSummary = Schema.Struct({
  kind: PipelineKind,
  name: Schema.String,
  active: Schema.Boolean,
  trigger: Schema.String,
  promptFileNames: Schema.Array(Schema.String),
});

const PipelineScenarioWithHint = Schema.Struct({
  kind: PipelineKind,
  name: Schema.String,
  pipelinePrompt: Schema.String,
  promptFiles: Schema.Array(ResearchPromptFile),
  active: Schema.Boolean,
  trigger: Schema.String,
  editHint: Schema.String,
});

export class PipelineToolError extends Schema.TaggedErrorClass<PipelineToolError>()(
  "PipelineToolError",
  { detail: Schema.String },
) {}

export const PipelineListTool = Tool.make("pipeline_list", {
  description:
    "List the named development and research pipelines configured in this d4research environment. Use pipeline_get before editing one.",
  parameters: Schema.Struct({ kind: Schema.optional(PipelineKind) }),
  success: Schema.Struct({ pipelines: Schema.Array(PipelineSummary) }),
  failure: PipelineToolError,
  dependencies,
})
  .annotate(Tool.Title, "List d4research pipelines")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PipelineGetTool = Tool.make("pipeline_get", {
  description:
    "Read one complete d4research pipeline, including its prompt and attached prompt files. Returns the exact trigger and edit guidance.",
  parameters: PipelineSelector,
  success: PipelineScenarioWithHint,
  failure: PipelineToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a d4research pipeline")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PipelineUpsertTool = Tool.make("pipeline_upsert", {
  description:
    "Create or replace one named d4research pipeline atomically. Read an existing pipeline first; omitting promptFiles preserves its attachments.",
  parameters: Schema.Struct({
    ...PipelineSelector.fields,
    pipelinePrompt: Schema.String.check(Schema.isMaxLength(RESEARCH_PIPELINE_PROMPT_MAX_CHARS)),
    promptFiles: Schema.optional(
      Schema.Array(ResearchPromptFile).check(Schema.isMaxLength(RESEARCH_PROMPT_FILE_MAX_COUNT)),
    ),
    makeActive: Schema.optional(Schema.Boolean),
  }),
  success: PipelineScenario,
  failure: PipelineToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create or update a d4research pipeline")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PipelineDeleteTool = Tool.make("pipeline_delete", {
  description:
    "Delete one named d4research pipeline atomically. This cannot be undone; read it first and confirm the user requested deletion.",
  parameters: PipelineSelector,
  success: Schema.Struct({ kind: PipelineKind, name: Schema.String, deleted: Schema.Boolean }),
  failure: PipelineToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete a d4research pipeline")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const PipelinesToolkit = Toolkit.make(
  PipelineListTool,
  PipelineGetTool,
  PipelineUpsertTool,
  PipelineDeleteTool,
);
