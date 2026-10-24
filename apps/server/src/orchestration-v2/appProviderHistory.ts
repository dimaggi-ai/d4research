import type { OrchestrationV2Run, OrchestrationV2TurnItem, RunId } from "@d4research/contracts";
import { historicalMessage } from "@d4research/provider-core/server/handoffBudget";

export function selectAppProviderHistory(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
  currentRunId: RunId,
) {
  const completedRuns = new Set(
    runs.filter((run) => run.status === "completed").map((run) => run.id),
  );
  return items.flatMap((item) => {
    if (item.runId === currentRunId || item.status !== "completed") return [];
    // Failed or interrupted model output is not an authoritative assistant reply.
    if (item.type !== "user_message" && item.runId !== null && !completedRuns.has(item.runId))
      return [];
    const message = historicalMessage(item);
    return message === null ? [] : [message];
  });
}
