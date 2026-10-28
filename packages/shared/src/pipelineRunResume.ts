import { parseDevTrigger } from "./devPipeline.ts";
import { extractTrailingEnabledSkillsContext } from "./enabledSkillsContext.ts";
import { parseResearchTrigger } from "./researchPipeline.ts";

/**
 * Which pipeline runs a new turn continues. Shared by the server (RESUME note,
 * budget carry-over, the Resume command) and clients (the Resume affordance),
 * so both agree on when a thread is resumable.
 */
export interface ResumeChainRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly startedAt: unknown;
  readonly userMessageId: string;
}

export interface ResumeChainMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export type PipelineInterruption = "restart" | "user" | "failed";

export interface PipelineResumeContext {
  /** Unfinished runs this turn continues, newest first. */
  readonly chain: ReadonlyArray<ResumeChainRun>;
  readonly interruption: PipelineInterruption;
}

export const isPipelineTriggerText = (text: string): boolean => {
  const prompt = extractTrailingEnabledSkillsContext(text).promptText;
  const body = prompt.startsWith("Ultrathink:\n") ? prompt.slice("Ultrathink:\n".length) : prompt;
  return parseResearchTrigger(body) !== null || parseDevTrigger(body) !== null;
};

/**
 * A run that started and stopped before finishing. `cancelled` after a start
 * only comes from the server stopping or reconciling at startup; a user stop
 * is `interrupted`. Queued runs cancelled before they started do not count.
 */
export const isResumableRun = (run: Pick<ResumeChainRun, "status" | "startedAt">): boolean =>
  run.startedAt !== null &&
  run.startedAt !== undefined &&
  (run.status === "cancelled" || run.status === "interrupted" || run.status === "failed");

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const interruptionOf = (run: ResumeChainRun): PipelineInterruption =>
  run.status === "cancelled" ? "restart" : run.status === "interrupted" ? "user" : "failed";

/**
 * Unfinished pipeline runs directly before `beforeOrdinal`. Runs that never
 * started are skipped; a completed run ends the chain, so a pipeline started
 * after a finished one is a fresh run.
 */
const chainBefore = (
  runs: ReadonlyArray<ResumeChainRun>,
  messages: ReadonlyArray<ResumeChainMessage>,
  beforeOrdinal: number,
): PipelineResumeContext | null => {
  const userTexts = new Map(
    messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message.text]),
  );
  const earlier = runs
    .filter(
      (run) => run.ordinal < beforeOrdinal && run.startedAt !== null && run.startedAt !== undefined,
    )
    .sort((left, right) => right.ordinal - left.ordinal);
  const chain: Array<ResumeChainRun> = [];
  for (const run of earlier) {
    if (!isResumableRun(run)) break;
    chain.push(run);
  }
  const latest = chain[0];
  if (latest === undefined) return null;
  const startedPipeline = runs.some((run) => {
    const text = userTexts.get(run.userMessageId);
    return run.ordinal < beforeOrdinal && text !== undefined && isPipelineTriggerText(text);
  });
  return startedPipeline ? { chain, interruption: interruptionOf(latest) } : null;
};

/**
 * Whether `currentRunId` continues an unfinished pipeline run. A message that
 * starts a pipeline again is a fresh run with a fresh budget; any other
 * follow-up after an unfinished run resumes it.
 */
export const resumeContextFor = (input: {
  readonly runs: ReadonlyArray<ResumeChainRun>;
  readonly messages: ReadonlyArray<ResumeChainMessage>;
  readonly currentRunId: string;
}): PipelineResumeContext | null => {
  const current = input.runs.find((run) => run.id === input.currentRunId);
  if (current === undefined) return null;
  const currentText = input.messages.find(
    (message) => message.id === current.userMessageId && message.role === "user",
  )?.text;
  if (currentText !== undefined && isPipelineTriggerText(currentText)) return null;
  return chainBefore(input.runs, input.messages, current.ordinal);
};

/** What the next turn would resume; null while a run is active or nothing is unfinished. */
export const pendingPipelineResume = (input: {
  readonly runs: ReadonlyArray<ResumeChainRun>;
  readonly messages: ReadonlyArray<ResumeChainMessage>;
}): PipelineResumeContext | null => {
  if (input.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return null;
  return chainBefore(input.runs, input.messages, Number.POSITIVE_INFINITY);
};
