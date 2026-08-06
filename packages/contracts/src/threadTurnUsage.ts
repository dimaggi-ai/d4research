import * as Schema from "effect/Schema";

import { ThreadId, TurnId } from "./baseSchemas.ts";

export const ThreadTurnUsageRow = Schema.Struct({
  turnId: TurnId,
  provider: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  usedTokens: Schema.NullOr(Schema.Int),
  maxTokens: Schema.NullOr(Schema.Int),
  totalProcessedTokens: Schema.NullOr(Schema.Int),
  inputTokens: Schema.NullOr(Schema.Int),
  cachedInputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  reasoningOutputTokens: Schema.NullOr(Schema.Int),
  toolUses: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Int),
  totalCostUsd: Schema.NullOr(Schema.Number),
});
export type ThreadTurnUsageRow = typeof ThreadTurnUsageRow.Type;

export const ThreadTurnUsageInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadTurnUsageInput = typeof ThreadTurnUsageInput.Type;
