import {
  DEFAULT_D4_AGENT_LOOP_ITERATIONS,
  type D4AgentAction,
  type D4AgentLaunchPreview,
  type D4AgentTaskMode,
} from "@d4research/contracts";

type StartAction = Extract<D4AgentAction, { type: "start" }>;

export type TaskOutcome = "completed" | "blocked" | "failed" | "needs-input";

export function startTaskMode(action: StartAction): D4AgentTaskMode {
  return action.mode ?? "single";
}

/** A loop needs explicit criteria; without them it would have no honest place to stop. */
export function startActionProblem(action: StartAction): string | null {
  if (startTaskMode(action) === "loop" && action.completionCriteria === undefined)
    return "A loop task needs completionCriteria that say when the work is done.";
  if (startTaskMode(action) === "single" && action.maxIterations !== undefined)
    return "maxIterations applies only to loop tasks.";
  return null;
}

const OUTCOME_LINE =
  "End your final message with exactly one line `Outcome: completed`, `Outcome: blocked`, `Outcome: failed` or `Outcome: needs-input`, followed by the evidence for it. Write completed only when verification passed; a finished turn is not proof of success.";

/** The exact prompt a start card delivers to its task thread. */
export function composeStartPrompt(action: StartAction): string {
  if (startTaskMode(action) === "single") {
    return `${action.text}

---
Single task. Do the work, then verify the result against the requested outcome with concrete evidence such as commands run, tests and changed files. ${OUTCOME_LINE} Nia reads this result, and the thread settles automatically after a verified completion.`;
  }
  const iterations = action.maxIterations ?? DEFAULT_D4_AGENT_LOOP_ITERATIONS;
  return `${action.text}

---
Loop task. Work in iterations: choose the next step, do it, then check every completion criterion below with concrete evidence. Continue while a criterion is unmet and progress is possible, for at most ${iterations} iterations. Stop early and report if you are blocked, a step failed and cannot be recovered, or you need the user's input.

Completion criteria:
${action.completionCriteria ?? ""}

${OUTCOME_LINE} List each criterion with its evidence. This thread stays open after it reports.`;
}

/** The worker's own verdict from its final message, if it gave one. */
export function parseTaskOutcome(result: string): TaskOutcome | null {
  const matches = [
    ...result.matchAll(/^\s*\**Outcome:?\**:?\s*(completed|blocked|failed|needs-input)\b/gim),
  ];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  return last === "completed" || last === "blocked" || last === "failed" || last === "needs-input"
    ? last
    : null;
}

export function launchPreviewsMatch(a: D4AgentLaunchPreview, b: D4AgentLaunchPreview): boolean {
  return (
    a.projectId === b.projectId &&
    a.workspaceRoot === b.workspaceRoot &&
    a.workspace === b.workspace &&
    a.runtimeMode === b.runtimeMode &&
    a.mode === b.mode &&
    a.prompt === b.prompt &&
    a.modelSelection.instanceId === b.modelSelection.instanceId &&
    a.modelSelection.model === b.modelSelection.model &&
    JSON.stringify(a.modelSelection.options ?? []) ===
      JSON.stringify(b.modelSelection.options ?? [])
  );
}
