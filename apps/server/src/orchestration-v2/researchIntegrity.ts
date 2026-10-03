/**
 * Research honesty guard — pure detection over one persisted V2 run.
 *
 * A research/dev orchestrator must call the real research delegate. Assistant
 * narration, a ToolSearch discovery item, or a completion claim is not proof
 * that research ran. The reactor consumes completed runs and persists a
 * warning system notice when the run claims progress without a delegate call.
 */
import type { OrchestrationV2ThreadProjection, RunId } from "@d4research/contracts";
import { parseDevTrigger } from "@d4research/shared/devPipeline";
import { parseResearchTrigger } from "@d4research/shared/researchPipeline";

/** Marker line included by expanded research orchestrator prompts. */
export const RESEARCH_ORCHESTRATOR_SENTINEL = "Execution protocol (non-negotiable):";
/** Dev pipelines use the same delegate engine with a distinct client briefing. */
export const DEV_ORCHESTRATOR_SENTINEL = "Dev pipeline protocol (non-negotiable):";

/** Activity kind also used to make warning insertion idempotent per run. */
export const RESEARCH_INTEGRITY_WARNING_KIND = "research.integrity-warning";

export type ResearchIntegrityProjection = Pick<OrchestrationV2ThreadProjection, "turnItems">;

function belongsToRun(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  runId: RunId,
): boolean {
  return item.runId === runId;
}

function hasResearchRunManifest(projection: ResearchIntegrityProjection, runId: RunId): boolean {
  return projection.turnItems.some(
    (item) =>
      belongsToRun(item, runId) &&
      item.type === "system_notice" &&
      item.activity?.kind === "research.run.started",
  );
}

/**
 * A run is a pipeline orchestration if its durable user item contains the
 * expanded protocol sentinel or its compact `!research` / `!dev` trigger, or
 * if turn-start persisted the explicit research manifest system notice.
 */
export function isPipelineOrchestratorRun(
  projection: ResearchIntegrityProjection,
  runId: RunId,
): boolean {
  if (hasResearchRunManifest(projection, runId)) return true;
  return projection.turnItems.some((item) => {
    if (!belongsToRun(item, runId) || item.type !== "user_message") return false;
    return (
      item.text.includes(RESEARCH_ORCHESTRATOR_SENTINEL) ||
      item.text.includes(DEV_ORCHESTRATOR_SENTINEL) ||
      parseResearchTrigger(item.text) !== null ||
      parseDevTrigger(item.text) !== null
    );
  });
}

// Step 1 is the orchestrator's own brief; any step >= 2 must be delegated.
// Matches `[step N | visit K]` and `# Step N:` progress markers.
const STEP_MARKER_RE = /\[\s*step\s+(\d+)\b|^#{1,6}\s*step\s+(\d+)\b/gim;

export function hasAdvancedPastBrief(
  projection: ResearchIntegrityProjection,
  runId: RunId,
): boolean {
  for (const item of projection.turnItems) {
    if (!belongsToRun(item, runId) || item.type !== "assistant_message") continue;
    STEP_MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STEP_MARKER_RE.exec(item.text)) !== null) {
      const step = Number(match[1] ?? match[2]);
      if (Number.isFinite(step) && step >= 2) return true;
    }
  }
  return false;
}

// These phrases are pipeline protocol claims, not ordinary coding answers.
const PIPELINE_COMPLETION_CLAIM_RE =
  /(?:^|\n)\s*RUN STATE\b|\b(?:research|dev) pipeline (?:is )?complete\b|\bfinal synthesis\b/gim;

export function claimsPipelineCompletion(
  projection: ResearchIntegrityProjection,
  runId: RunId,
): boolean {
  return projection.turnItems.some((item) => {
    if (!belongsToRun(item, runId) || item.type !== "assistant_message") return false;
    PIPELINE_COMPLETION_CLAIM_RE.lastIndex = 0;
    return PIPELINE_COMPLETION_CLAIM_RE.test(item.text);
  });
}

// ToolSearch's `select:research_delegate` is discovery, not invocation. Only a
// dynamic_tool item whose actual tool name is research_delegate proves work.
const RESEARCH_DELEGATE_NAME_RE = /(?:^|__)research_delegate$/i;

function isResearchDelegateName(toolName: string | null): boolean {
  return toolName !== null && RESEARCH_DELEGATE_NAME_RE.test(toolName);
}

export function countResearchDelegations(
  projection: ResearchIntegrityProjection,
  runId: RunId,
): number {
  return projection.turnItems.filter(
    (item) =>
      belongsToRun(item, runId) &&
      item.type === "dynamic_tool" &&
      isResearchDelegateName(item.toolName),
  ).length;
}

export function alreadyWarned(projection: ResearchIntegrityProjection, runId: RunId): boolean {
  return projection.turnItems.some(
    (item) =>
      belongsToRun(item, runId) &&
      item.type === "system_notice" &&
      item.activity?.kind === RESEARCH_INTEGRITY_WARNING_KIND,
  );
}

/** A fake pipeline is a completed orchestration run that claimed progress but never delegated. */
export function shouldWarnFakedPipeline(
  projection: ResearchIntegrityProjection,
  runId: RunId,
): boolean {
  return (
    isPipelineOrchestratorRun(projection, runId) &&
    !alreadyWarned(projection, runId) &&
    (hasAdvancedPastBrief(projection, runId) || claimsPipelineCompletion(projection, runId)) &&
    countResearchDelegations(projection, runId) === 0
  );
}
