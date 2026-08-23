import { IsoDateTime, NonNegativeInt, ProviderInstanceId, ThreadId } from "@d4research/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadResumeSchedule = Schema.Struct({
  threadId: ThreadId,
  resumeAt: IsoDateTime,
  reason: Schema.String,
  provider: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  createdAt: IsoDateTime,
  attempts: NonNegativeInt,
});
export type ProjectionThreadResumeSchedule = typeof ProjectionThreadResumeSchedule.Type;

export const ListDueProjectionThreadResumeScheduleInput = Schema.Struct({
  now: IsoDateTime,
});
export type ListDueProjectionThreadResumeScheduleInput =
  typeof ListDueProjectionThreadResumeScheduleInput.Type;

export const ProjectionThreadResumeScheduleThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionThreadResumeScheduleThreadInput =
  typeof ProjectionThreadResumeScheduleThreadInput.Type;

export interface ProjectionThreadResumeScheduleRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadResumeSchedule,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listDue: (
    input: ListDueProjectionThreadResumeScheduleInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadResumeSchedule>, ProjectionRepositoryError>;
  readonly getByThreadId: (
    input: ProjectionThreadResumeScheduleThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadResumeSchedule>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ProjectionThreadResumeScheduleThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadResumeScheduleRepository extends Context.Service<
  ProjectionThreadResumeScheduleRepository,
  ProjectionThreadResumeScheduleRepositoryShape
>()(
  "d4research/persistence/Services/ProjectionThreadResumeSchedule/ProjectionThreadResumeScheduleRepository",
) {}
