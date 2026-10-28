import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

export const PipelineRunResumeInput = Schema.Struct({ threadId: ThreadId });
export type PipelineRunResumeInput = typeof PipelineRunResumeInput.Type;

export const PipelineRunResumeResult = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  /** True when a d4-action task was re-approved against the pipeline as it is now. */
  repinnedPipeline: Schema.Boolean,
});
export type PipelineRunResumeResult = typeof PipelineRunResumeResult.Type;

export class PipelineRunResumeError extends Schema.TaggedError<PipelineRunResumeError>()(
  "PipelineRunResumeError",
  {
    reason: Schema.Literals(["not-resumable", "busy", "scope-refused", "unavailable"]),
    detail: Schema.String,
  },
) {}
