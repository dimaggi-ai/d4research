/**
 * Research honesty guard — pure detection.
 *
 * A research-orchestrator thread is meant to drive the pipeline by calling the
 * `research_delegate` MCP tool. A weak orchestrator model can instead narrate
 * the whole pipeline as prose — emitting `[step N]` markers and even a finished
 * deliverable — without ever delegating, so nothing is actually researched or
 * verified. These predicates detect that "faked pipeline" from a thread
 * snapshot; the reactor that consumes them is a thin wrapper.
 */
import type { OrchestrationThread, TurnId } from "@t3tools/contracts";
import { parseDevTrigger } from "@t3tools/shared/devPipeline";

/**
 * Marker line the expanded orchestrator prompt always carries (mirrors
 * `RESEARCH_ORCHESTRATOR_SENTINEL` in apps/web `researchPipeline.ts`). The
 * Research is expanded by the client; dev is expanded at the provider
 * boundary and therefore also recognizes its compact persisted trigger.
 */
export const RESEARCH_ORCHESTRATOR_SENTINEL = "Execution protocol (non-negotiable):";
/** Dev pipelines use the same delegate engine with a distinct client briefing. */
export const DEV_ORCHESTRATOR_SENTINEL = "Dev pipeline protocol (non-negotiable):";

/** Activity kind emitted by the guard; also its warn-once marker per thread. */
export const RESEARCH_INTEGRITY_WARNING_KIND = "research.integrity-warning";

export function isPipelineOrchestratorTurn(thread: OrchestrationThread, turnId?: TurnId): boolean {
  return thread.messages.some(
    (message) =>
      message.role === "user" &&
      (turnId === undefined || message.turnId === turnId) &&
      (message.text.includes(RESEARCH_ORCHESTRATOR_SENTINEL) ||
        message.text.includes(DEV_ORCHESTRATOR_SENTINEL) ||
        parseDevTrigger(message.text) !== null),
  );
}

// Step 1 is the brief the orchestrator writes itself; any step >= 2 must be
// delegated. Matches `[step N | visit K]` and `# Step N:` progress markers.
const STEP_MARKER_RE = /\[\s*step\s+(\d+)\b|^#{1,6}\s*step\s+(\d+)\b/gim;

/** True once the orchestrator's own output claims to have moved past the brief. */
export function hasAdvancedPastBrief(thread: OrchestrationThread, turnId?: TurnId): boolean {
  for (const message of thread.messages) {
    if (message.role !== "assistant" || (turnId !== undefined && message.turnId !== turnId))
      continue;
    STEP_MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STEP_MARKER_RE.exec(message.text)) !== null) {
      const step = Number(match[1] ?? match[2]);
      if (Number.isFinite(step) && step >= 2) return true;
    }
  }
  return false;
}

// The required final report can be forged without printing step markers. Keep
// this deliberately narrow: these phrases are emitted by pipeline protocol,
// not ordinary coding answers.
const PIPELINE_COMPLETION_CLAIM_RE =
  /(?:^|\n)\s*RUN STATE\b|\b(?:research|dev) pipeline (?:is )?complete\b|\bfinal synthesis\b/gim;

export function claimsPipelineCompletion(thread: OrchestrationThread, turnId?: TurnId): boolean {
  return thread.messages.some((message) => {
    if (message.role !== "assistant" || (turnId !== undefined && message.turnId !== turnId)) {
      return false;
    }
    PIPELINE_COMPLETION_CLAIM_RE.lastIndex = 0;
    return PIPELINE_COMPLETION_CLAIM_RE.test(message.text);
  });
}

// A genuine delegation is an MCP tool call named `mcp__…research_delegate`. The
// ToolSearch discovery step (`select:research_delegate`) is intentionally not
// matched — it carries no `mcp__` name — so only real invocations count.
const DELEGATION_RE = /mcp__[\w-]*research_delegate/i;

function payloadNamesResearchDelegate(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return DELEGATION_RE.test(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => payloadNamesResearchDelegate(entry, seen));
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "toolName" || key === "tool" || key === "name") &&
      typeof child === "string" &&
      /(?:^|__)research_delegate$/i.test(child)
    ) {
      return true;
    }
    if (payloadNamesResearchDelegate(child, seen)) return true;
  }
  return false;
}

export function countResearchDelegations(thread: OrchestrationThread, turnId?: TurnId): number {
  let count = 0;
  for (const activity of thread.activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    if (turnId !== undefined && activity.turnId !== turnId) continue;
    if (payloadNamesResearchDelegate(activity.payload)) count += 1;
  }
  return count;
}

export function alreadyWarned(thread: OrchestrationThread, turnId?: TurnId): boolean {
  return thread.activities.some(
    (activity) =>
      activity.kind === RESEARCH_INTEGRITY_WARNING_KIND &&
      (turnId === undefined || activity.turnId === turnId),
  );
}

/**
 * The orchestrator claimed to run the pipeline (advanced past the brief) but
 * never delegated once across the whole thread: a single model faked it.
 * Delegations are counted thread-wide, not per turn, so a run that genuinely
 * delegated earlier stays immune during a later prose-only synthesis turn.
 */
export function shouldWarnFakedPipeline(thread: OrchestrationThread, turnId?: TurnId): boolean {
  return (
    isPipelineOrchestratorTurn(thread, turnId) &&
    !alreadyWarned(thread, turnId) &&
    (hasAdvancedPastBrief(thread, turnId) || claimsPipelineCompletion(thread, turnId)) &&
    countResearchDelegations(thread, turnId) === 0
  );
}
