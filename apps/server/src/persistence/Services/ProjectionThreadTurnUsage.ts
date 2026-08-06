import { ThreadId, ThreadTurnUsageRow } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadTurnUsage = Schema.Struct({
  threadId: ThreadId,
  ...ThreadTurnUsageRow.fields,
});
export type ProjectionThreadTurnUsage = typeof ProjectionThreadTurnUsage.Type;

export const ListProjectionThreadTurnUsageInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadTurnUsageInput = typeof ListProjectionThreadTurnUsageInput.Type;

export const DeleteProjectionThreadTurnUsageInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadTurnUsageInput = typeof DeleteProjectionThreadTurnUsageInput.Type;

export interface ProjectionThreadTurnUsageRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadTurnUsage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly listByThreadId: (
    input: ListProjectionThreadTurnUsageInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadTurnUsage>, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionThreadTurnUsageInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadTurnUsageRepository extends Context.Service<
  ProjectionThreadTurnUsageRepository,
  ProjectionThreadTurnUsageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadTurnUsage/ProjectionThreadTurnUsageRepository") {}
