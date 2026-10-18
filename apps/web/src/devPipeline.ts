/**
 * Web compatibility export. Dev-pipeline parsing and compilation live in the
 * shared runtime because web, desktop, mobile, queued sends, and the server's
 * provider boundary must all interpret the same trigger identically.
 */
export {
  activeDevScenarioName,
  applyDevTrigger,
  buildDefaultDevPipelinePrompt,
  deriveDevProviderCandidates,
  devPipelineControlKind,
  expandDevPipelinePrompt,
  findDevScenario,
  listDevScenarios,
  parseDevTrigger,
  parseDevPipelineOptionEvent,
  providerDriverSupportsPipelineOrchestration,
  shouldExitPlanForDevPipelineSelection,
  stripDevTrigger,
  type DevProviderCandidate,
  type DevTrigger,
} from "@d4research/shared/devPipeline";

import { parseDevTrigger } from "@d4research/shared/devPipeline";

export function isDevPipelinePrompt(prompt: string): boolean {
  return parseDevTrigger(prompt) !== null;
}
