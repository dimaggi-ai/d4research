import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NotesListInput = Schema.Struct({ threadId: ThreadId });
export const NotesReadInput = Schema.Struct({
  threadId: ThreadId,
  artifact: TrimmedNonEmptyString,
  offset: NonNegativeInt,
});
export const NotesEntry = Schema.Struct({
  artifact: Schema.String,
  step: Schema.String,
  visit: NonNegativeInt,
  runId: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  at: Schema.String,
  chars: NonNegativeInt,
});
export const NotesListResult = Schema.Struct({
  folder: Schema.String,
  folderStatus: Schema.Literals(["disabled", "available", "unavailable"]),
  entries: Schema.Array(NotesEntry),
  error: Schema.NullOr(Schema.String),
});
export type NotesListResult = typeof NotesListResult.Type;
export const NotesReadResult = Schema.Struct({
  artifact: Schema.String,
  text: Schema.String,
  totalChars: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type NotesReadResult = typeof NotesReadResult.Type;
export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  message: Schema.String,
}) {}
