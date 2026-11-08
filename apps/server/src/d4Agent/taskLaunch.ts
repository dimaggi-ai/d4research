import type { D4AgentAction, D4AgentLaunchPreview, D4AgentTaskMode } from "@d4research/contracts";

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
  if (startTaskMode(action) === "single" && action.doneWhen === undefined)
    return "A single task needs doneWhen: the check that proves it is finished.";
  return null;
}

const OUTCOME_LINE =
  "End your final message with exactly one line `Outcome: completed`, `Outcome: blocked`, `Outcome: failed` or `Outcome: needs-input`, followed by the evidence for it. Write completed only when verification passed; a finished turn is not proof of success.";

export interface StartTarget {
  readonly workspaceRoot: string;
  readonly workspace: "root" | "worktree";
}

/** The self-contained brief: the task thread never sees the chat that produced it. */
function briefSection(action: StartAction, target: StartTarget): string {
  const folder =
    target.workspace === "worktree"
      ? `a fresh worktree of ${target.workspaceRoot || "the project"} created for this task`
      : target.workspaceRoot || "the project root";
  const doneWhen =
    startTaskMode(action) === "single" ? `Done when: ${action.doneWhen ?? ""}\n` : "";
  return `Brief
Target directory: ${folder}. Work only inside it.
Constraints: ${action.constraints ?? "None beyond the request above."}
${doneWhen}This brief is all the context you get; you cannot see the conversation that produced it. If something essential is missing or ambiguous, stop with \`Outcome: needs-input\` and name what you need instead of guessing.`;
}

/** The exact prompt a start card delivers to its task thread. */
export function composeStartPrompt(action: StartAction, target: StartTarget): string {
  if (startTaskMode(action) === "single") {
    return `${action.text}

---
${briefSection(action, target)}

---
Single task. Do the work, then verify the result against the done-when check with concrete evidence such as commands run, tests and changed files. ${OUTCOME_LINE} Nia reads this result, and the thread settles automatically after a verified completion.`;
  }
  const budget =
    action.maxIterations === undefined
      ? ""
      : ` The user set a budget of ${action.maxIterations} iterations; if it runs out first, stop with \`Outcome: needs-input\` and list the criteria still unmet.`;
  return `${action.text}

---
${briefSection(action, target)}

---
Loop task. Work in iterations: choose the next step, do it, then check every completion criterion below with concrete evidence. Keep going until every criterion holds. Stop only to report when the work is complete, you are blocked, a step failed and cannot be recovered, or you need the user's input.${budget}

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
