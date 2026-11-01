import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsListRefsResult, VcsStatusLocalResult } from "./git.ts";

export class ThreadWorkspaceError extends Schema.TaggedError<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  {
    message: Schema.String,
  },
) {}

export const ThreadWorkspaceSelection = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadWorkspaceSelection = typeof ThreadWorkspaceSelection.Type;

const scope = { threadId: ThreadId, workspaceRoot: Schema.optional(TrimmedNonEmptyString) };
export const ThreadWorkspaceInspectInput = Schema.Struct({
  ...scope,
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const ThreadWorkspaceSelectInput = Schema.Struct({
  ...scope,
  path: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
});
export const ThreadWorkspaceCreateInput = Schema.Struct({
  ...scope,
  mode: Schema.Literal("worktree"),
  branch: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export const ThreadWorkspaceResult = Schema.Struct({
  workspaceRoot: Schema.String,
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  primary: Schema.Boolean,
  instructions: Schema.String,
});
export const ThreadWorkspaceInspectResult = Schema.Struct({
  projectRoot: Schema.String,
  workspaceRoot: Schema.String,
  cwd: Schema.String,
  workspaces: Schema.Array(
    Schema.Struct({
      workspaceRoot: Schema.String,
      cwd: Schema.String,
      label: Schema.optional(Schema.String),
      primary: Schema.Boolean,
      branch: Schema.NullOr(Schema.String),
    }),
  ),
  status: VcsStatusLocalResult,
  refs: VcsListRefsResult,
});
