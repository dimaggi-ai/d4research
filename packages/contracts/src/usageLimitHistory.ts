import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

export const UsageLimitHistoryInput = Schema.Struct({
  days: Schema.Literals([1, 7, 30, 90]),
});
export type UsageLimitHistoryInput = typeof UsageLimitHistoryInput.Type;

export const UsageLimitHistoryPoint = Schema.Struct({
  accountId: Schema.String,
  label: Schema.String,
  color: Schema.NullOr(Schema.String),
  windowId: Schema.String,
  windowLabel: Schema.String,
  measuredAt: IsoDateTime,
  remainingPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.String),
});
export type UsageLimitHistoryPoint = typeof UsageLimitHistoryPoint.Type;

export const UsageLimitHistory = Schema.Struct({
  readAt: IsoDateTime,
  since: IsoDateTime,
  resolutionMinutes: Schema.Finite,
  truncated: Schema.Boolean,
  points: Schema.Array(UsageLimitHistoryPoint),
});
export type UsageLimitHistory = typeof UsageLimitHistory.Type;
