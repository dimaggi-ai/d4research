import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const Day = Schema.NullOr(Schema.String);
const Id = Schema.String.check(Schema.isUUID());

export class AlmanacError extends Schema.TaggedError<AlmanacError>()("AlmanacError", {
  code: Schema.Literals(["not_configured", "unavailable", "rejected", "malformed"]),
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "not_configured":
        return "Almanac is not configured on this environment.";
      case "unavailable":
        return "Almanac could not be reached.";
      case "rejected":
        return `Almanac refused ${this.operation}.`;
      case "malformed":
        return `Almanac returned an unreadable reply to ${this.operation}.`;
    }
  }
}

export const AlmanacStatus = Schema.Struct({
  configured: Schema.Boolean,
  connected: Schema.Boolean,
});
export type AlmanacStatus = typeof AlmanacStatus.Type;

export const AlmanacMemory = Schema.Struct({
  id: Schema.String,
  date: Day,
  text: Schema.String,
  category: Schema.NullOr(Schema.String),
  replacedBy: Schema.NullOr(Schema.String),
});
export type AlmanacMemory = typeof AlmanacMemory.Type;

export const AlmanacPassage = Schema.Struct({
  sourceId: Schema.String,
  start: Schema.Int,
  end: Schema.Int,
  date: Day,
  title: Schema.String,
  text: Schema.String,
});
export type AlmanacPassage = typeof AlmanacPassage.Type;

export const AlmanacCategory = Schema.Struct({ path: Schema.String, items: Schema.Int });
export type AlmanacCategory = typeof AlmanacCategory.Type;

export const AlmanacBrowseInput = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(1024)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AlmanacBrowseInput = typeof AlmanacBrowseInput.Type;

export const AlmanacBrowseResult = Schema.Struct({
  categories: Schema.Array(AlmanacCategory),
  memories: Schema.Array(AlmanacMemory),
  passages: Schema.Array(AlmanacPassage),
  nextOffset: Schema.NullOr(Schema.Int),
  total: Schema.NullOr(Schema.Int),
});
export type AlmanacBrowseResult = typeof AlmanacBrowseResult.Type;

const Limit = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20));

export const AlmanacSearchInput = Schema.Struct({
  query: Text,
  limit: Schema.optionalKey(Limit),
});
export type AlmanacSearchInput = typeof AlmanacSearchInput.Type;

export const AlmanacSearchResult = Schema.Struct({
  passages: Schema.Array(AlmanacPassage),
  indexingIncomplete: Schema.Boolean,
});
export type AlmanacSearchResult = typeof AlmanacSearchResult.Type;

export const AlmanacRecallResult = Schema.Struct({ memories: Schema.Array(AlmanacMemory) });
export type AlmanacRecallResult = typeof AlmanacRecallResult.Type;

export const AlmanacReadInput = Schema.Struct({
  sourceId: Id,
  start: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8000)),
  ),
});
export type AlmanacReadInput = typeof AlmanacReadInput.Type;

export const AlmanacReadResult = Schema.Struct({
  uri: Schema.String,
  start: Schema.Int,
  end: Schema.Int,
  total: Schema.Int,
  content: Schema.String,
});
export type AlmanacReadResult = typeof AlmanacReadResult.Type;

export const AlmanacRememberInput = Schema.Struct({ text: Text });
export type AlmanacRememberInput = typeof AlmanacRememberInput.Type;

export const AlmanacUpdateInput = Schema.Struct({ memoryId: Id, text: Text });
export type AlmanacUpdateInput = typeof AlmanacUpdateInput.Type;

export const AlmanacForgetInput = Schema.Struct({ memoryId: Id });
export type AlmanacForgetInput = typeof AlmanacForgetInput.Type;

export const AlmanacWriteResult = Schema.Struct({ result: Schema.String });
export type AlmanacWriteResult = typeof AlmanacWriteResult.Type;
