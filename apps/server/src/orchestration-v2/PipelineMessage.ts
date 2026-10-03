import type { DevSettings, ResearchSettings, PipelineTargetPolicy } from "@d4research/contracts";
import {
  expandDevPipelinePrompt,
  parseDevTrigger,
  type DevProviderCandidate,
} from "@d4research/shared/devPipeline";
import {
  expandResearchPipelinePrompt,
  parseResearchTrigger,
  type ResearchProviderCandidate,
} from "@d4research/shared/researchPipeline";
const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";

/**
 * Expand only the provider-bound copy of a dev trigger. The persisted message
 * remains the compact user-authored text, including when Claude prompt effort
 * prepends its transport-only `Ultrathink:` marker.
 */
export function expandProviderDevMessage(
  messageText: string,
  settings: Pick<DevSettings, "scenarios" | "activeScenario"> | undefined,
  candidates: ReadonlyArray<DevProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  const hasEffortPrefix = messageText.startsWith(CLAUDE_ULTRATHINK_PREFIX);
  const prompt = hasEffortPrefix ? messageText.slice(CLAUDE_ULTRATHINK_PREFIX.length) : messageText;
  if (parseDevTrigger(prompt) === null) return messageText;
  const expanded = expandDevPipelinePrompt(prompt, settings, candidates, targetPolicy);
  return hasEffortPrefix ? `${CLAUDE_ULTRATHINK_PREFIX}${expanded}` : expanded;
}

/**
 * Expand only the provider-bound copy of a research trigger. The compact
 * trigger remains in event history, transcripts, handoffs, and remote sync.
 */
export function expandProviderResearchMessage(
  messageText: string,
  settings:
    | Pick<ResearchSettings, "scenarios" | "activeScenario" | "pipelinePrompt" | "promptFiles">
    | undefined,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  const hasEffortPrefix = messageText.startsWith(CLAUDE_ULTRATHINK_PREFIX);
  const prompt = hasEffortPrefix ? messageText.slice(CLAUDE_ULTRATHINK_PREFIX.length) : messageText;
  if (parseResearchTrigger(prompt) === null) return messageText;
  const expanded = expandResearchPipelinePrompt(prompt, settings, candidates, targetPolicy);
  return hasEffortPrefix ? `${CLAUDE_ULTRATHINK_PREFIX}${expanded}` : expanded;
}
