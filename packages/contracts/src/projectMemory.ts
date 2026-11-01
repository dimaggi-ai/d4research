import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export const ProjectMemoryFields = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ),
  description: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
});
export const ProjectMemory = Schema.Struct({
  ...ProjectMemoryFields.fields,
  updatedAt: Schema.String,
});
export type ProjectMemory = typeof ProjectMemory.Type;
export const ProjectMemorySummary = Schema.Struct({
  name: ProjectMemoryFields.fields.name,
  description: ProjectMemoryFields.fields.description,
  updatedAt: Schema.String,
});
export const ProjectMemoryKey = Schema.Struct({
  projectId: ProjectId,
  name: ProjectMemoryFields.fields.name,
});
export const ProjectMemoryListInput = Schema.Struct({ projectId: ProjectId });
export const ProjectMemorySaveInput = Schema.Struct({
  projectId: ProjectId,
  ...ProjectMemoryFields.fields,
});
export class ProjectMemoryError extends Schema.TaggedError<ProjectMemoryError>()(
  "ProjectMemoryError",
  {
    message: Schema.String,
  },
) {}
