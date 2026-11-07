import { OrchestratorMcpFailure } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as DecisionService from "../../../decision/DecisionService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DecisionToolkit } from "./tools.ts";

const toFailure = (error: DecisionService.DecisionError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "rejected" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  // Thread content leaves this server here, so only T3-launched agents may call it.
  decision_evaluate: McpToolAccess.readsAsCaller((input) =>
    DecisionService.DecisionService.pipe(
      Effect.flatMap((decisions) => decisions.evaluate(input)),
      Effect.mapError(toFailure),
    ),
  ),
  decision_rank: McpToolAccess.readsAsCaller((input) =>
    DecisionService.DecisionService.pipe(
      Effect.flatMap((decisions) => decisions.rank(input)),
      Effect.mapError(toFailure),
    ),
  ),
});
