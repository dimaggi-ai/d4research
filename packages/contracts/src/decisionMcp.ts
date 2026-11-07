import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const DECISION_MAX_QUESTIONS = 32;
const DECISION_MAX_CANDIDATES = 64;
const DECISION_MAX_CANDIDATE_LENGTH = 8_000;

export const DecisionQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: TrimmedNonEmptyString,
    criteria: Schema.optional(
      Schema.Struct({
        true: Schema.optional(Schema.String),
        false: Schema.optional(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: TrimmedNonEmptyString,
    criteria: Schema.Record(TrimmedNonEmptyString, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: TrimmedNonEmptyString,
    criteria: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  }),
]);
export type DecisionQuestion = typeof DecisionQuestion.Type;

export const DecisionAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    legend: Schema.Record(Schema.String, Schema.Unknown),
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.Number,
  }),
]);
export type DecisionAnswer = typeof DecisionAnswer.Type;

export const McpDecisionEvaluateInput = Schema.Struct({
  state: Schema.Unknown.annotate({
    description: "A string, object, or array holding everything the questions judge.",
  }),
  questions: Schema.Record(TrimmedNonEmptyString, DecisionQuestion).check(
    Schema.isMinProperties(1),
    Schema.isMaxProperties(DECISION_MAX_QUESTIONS),
  ),
});
export type McpDecisionEvaluateInput = typeof McpDecisionEvaluateInput.Type;

export const McpDecisionEvaluateResult = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, DecisionAnswer),
});
export type McpDecisionEvaluateResult = typeof McpDecisionEvaluateResult.Type;

export const McpDecisionRankInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  candidates: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(DECISION_MAX_CANDIDATE_LENGTH)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(DECISION_MAX_CANDIDATES)),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type McpDecisionRankInput = typeof McpDecisionRankInput.Type;

export const McpDecisionRankResult = Schema.Struct({
  model: Schema.String,
  results: Schema.Array(
    Schema.Struct({ id: Schema.String, relevance: Schema.Number, confidence: Schema.Number }),
  ),
});
export type McpDecisionRankResult = typeof McpDecisionRankResult.Type;
