import {
  McpDecisionEvaluateInput,
  McpDecisionEvaluateResult,
  McpDecisionRankInput,
  McpDecisionRankResult,
  OrchestratorMcpFailure,
} from "@d4research/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as DecisionService from "../../../decision/DecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, DecisionService.DecisionService],
};

export const DecisionToolkit = Toolkit.make(
  Tool.make("decision_evaluate", {
    ...shared,
    description:
      "Ask the OpenJev decision model typed questions about one state and get probabilities, not prose. Use noul for a yes/no condition (noul is the probability of yes), choice for one of a defined set (criteria maps each option to its meaning), and score for a position on ordered levels (criteria lists the levels from lowest to highest). Questions run independently and cannot see each other's answers. Put the full judgment in instructions; question IDs are not shown to the model. Reference state fields with backticks. Answers are judgments, not verified facts, and state is sent to the configured endpoint. Fails when no endpoint is set in Settings.",
    parameters: McpDecisionEvaluateInput,
    success: Schema.toCodecJson(McpDecisionEvaluateResult),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("decision_rank", {
    ...shared,
    description:
      "Rank research results or other text candidates by how directly each helps answer query, using the OpenJev decision model. Scores each candidate independently and returns them best first with relevance from 0 to 1 and confidence. Use it to filter sources before reading them in full. Ranks only what you pass and does not search. Candidate text is sent to the configured endpoint. Fails when no endpoint is set in Settings.",
    parameters: McpDecisionRankInput,
    success: Schema.toCodecJson(McpDecisionRankResult),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
