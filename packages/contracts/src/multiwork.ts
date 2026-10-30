import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// "Multiwork" creates an isolated, full copy of a git repository under a base directory and checks
// out a dedicated branch, so a task can run decoupled from the source working tree (the user's
// alternative to git worktrees).

export const MultiworkCreateInput = Schema.Struct({
  /** Any path inside the source repository; its toplevel is resolved server-side. */
  cwd: TrimmedNonEmptyString,
  /** Branch to create/continue in the copy (e.g. `spilshchikov-my-task`). */
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type MultiworkCreateInput = typeof MultiworkCreateInput.Type;

export const MultiworkCreateResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  /** True when an existing copy at the destination was reused rather than freshly cloned. */
  reused: Schema.Boolean,
});
export type MultiworkCreateResult = typeof MultiworkCreateResult.Type;

export const MultiworkCopy = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  branch: Schema.optional(Schema.String),
});
export type MultiworkCopy = typeof MultiworkCopy.Type;

export const MultiworkListResult = Schema.Struct({
  baseDirectory: TrimmedNonEmptyString,
  copies: Schema.Array(MultiworkCopy),
});
export type MultiworkListResult = typeof MultiworkListResult.Type;

export class MultiworkError extends Schema.TaggedError<MultiworkError>()("MultiworkError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Multiwork operation failed in ${this.operation}: ${this.detail}`;
  }
}
