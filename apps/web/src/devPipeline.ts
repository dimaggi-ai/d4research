/**
 * Web compatibility export. Dev-pipeline parsing and compilation live in the
 * shared runtime because web, desktop, mobile, queued sends, and the server's
 * provider boundary must all interpret the same trigger identically.
 */
export {
  activeDevScenarioName,
  applyDevTrigger,
  buildDefaultDevPipelinePrompt,
  DEFAULT_DEV_SCENARIO_NAME,
  DEV_PIPELINE_SENTINEL,
  DEV_PROTOCOL_SENTINEL,
  DEV_TRIGGER_PREFIX,
  deriveDevProviderCandidates,
  devPipelineControlKind,
  expandDevPipelinePrompt,
  findDevScenario,
  listDevScenarios,
  parseDevTrigger,
  parseDevPipelineOptionEvent,
  PIPELINE_DIRECTIVE_MAX_COUNT,
  providerDriverSupportsPipelineOrchestration,
  shouldExitPlanForDevPipelineSelection,
  stripDevTrigger,
  type DevProviderCandidate,
  type DevTrigger,
} from "@t3tools/shared/devPipeline";

import { parseDevTrigger } from "@t3tools/shared/devPipeline";

export function isDevPipelinePrompt(prompt: string): boolean {
  return parseDevTrigger(prompt) !== null;
}
