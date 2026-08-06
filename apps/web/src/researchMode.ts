import {
  DEFAULT_RESEARCH_STAGES,
  RESEARCH_STAGE_MAX_COUNT,
  type ResearchStageConfig,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "./providerInstances";

export const DEEP_RESEARCH_TAG = "#deep-research";

const CLI_BY_DRIVER: Readonly<Record<string, string>> = {
  agy: "agy",
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  grok: "grok",
  junie: "junie",
  opencode: "opencode",
};

const AGENT_ROLES = [
  ["Scout", "find primary evidence and map the problem"],
  ["Analyst", "test competing explanations and inspect implementation details"],
  ["Challenger", "look for missing evidence, regressions, and false confidence"],
  ["Synthesizer", "merge cited findings into the final answer"],
] as const;

export interface ResearchProviderCandidate {
  readonly instanceId: string;
  readonly name: string;
  readonly cli: string;
  readonly models: ReadonlyArray<string>;
}

// Discovery can yield malformed slugs (a CLI's spinner frames captured as a
// model name). They are unusable as `--model` arguments and would bloat the
// prompt, so keep only well-formed identifiers.
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_MODELS_PER_PROVIDER = 6;

export function sanitizeResearchModelSlugs(models: ReadonlyArray<string>): ReadonlyArray<string> {
  return models.filter((model) => MODEL_SLUG_REGEX.test(model)).slice(0, MAX_MODELS_PER_PROVIDER);
}

export function isDeepResearchPrompt(prompt: string): boolean {
  return prompt.trimStart().toLowerCase().startsWith(DEEP_RESEARCH_TAG);
}

/**
 * The stages a research thread runs, resolved from Settings → Deep Research:
 * enabled stages in configured order, capped at the contract maximum. When
 * nothing usable is configured (no settings yet, or everything disabled) the
 * built-in five stages from the contract remain the flow.
 */
export function resolveResearchStages(
  stages: ReadonlyArray<ResearchStageConfig> | undefined,
): ReadonlyArray<ResearchStageConfig> {
  const enabled = (stages ?? [])
    .filter((stage) => stage.enabled && stage.title.trim().length > 0)
    .slice(0, RESEARCH_STAGE_MAX_COUNT);
  return enabled.length > 0 ? enabled : DEFAULT_RESEARCH_STAGES;
}

function formatStagePositions(positions: ReadonlyArray<number>): string {
  if (positions.length === 2) return `${positions[0]} and ${positions[1]}`;
  return `${positions.slice(0, -1).join(", ")}, and ${positions[positions.length - 1]}`;
}

/**
 * Honest phrasing for parallel groups: the stages are independent, so they may
 * be interleaved — no claim that anything runs them simultaneously.
 */
export function describeParallelStageNotes(
  stages: ReadonlyArray<ResearchStageConfig>,
): ReadonlyArray<string> {
  const positionsByGroup = new Map<number, Array<number>>();
  stages.forEach((stage, index) => {
    if (stage.parallelGroup === undefined) return;
    const positions = positionsByGroup.get(stage.parallelGroup) ?? [];
    positions.push(index + 1);
    positionsByGroup.set(stage.parallelGroup, positions);
  });
  return [...positionsByGroup.values()]
    .filter((positions) => positions.length > 1)
    .map(
      (positions) =>
        `Stages ${formatStagePositions(positions)} are independent and may be worked in either order or interleaved.`,
    );
}

function stageSuggestionLabel(
  stage: ResearchStageConfig,
  providers: ReadonlyArray<ResearchProviderCandidate>,
): string | null {
  if (stage.suggestedInstanceId === undefined || stage.suggestedModel === undefined) return null;
  const [model] = sanitizeResearchModelSlugs([stage.suggestedModel]);
  if (model === undefined) return null;
  const candidate = providers.find((provider) => provider.instanceId === stage.suggestedInstanceId);
  return `${candidate?.name ?? stage.suggestedInstanceId} / ${model}`;
}

export function deriveResearchProviderCandidates(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ResearchProviderCandidate> {
  return entries
    .filter(
      (entry) =>
        entry.enabled && entry.isAvailable && entry.status === "ready" && entry.models.length > 0,
    )
    .map((entry) => ({
      instanceId: String(entry.instanceId),
      name: entry.displayName,
      cli: CLI_BY_DRIVER[entry.driverKind] ?? entry.driverKind,
      models: sanitizeResearchModelSlugs(entry.models.map((model) => model.slug)),
    }))
    .filter((provider) => provider.models.length > 0);
}

export function expandDeepResearchPrompt(
  prompt: string,
  providers: ReadonlyArray<ResearchProviderCandidate>,
  stageConfigs?: ReadonlyArray<ResearchStageConfig>,
): string {
  if (!isDeepResearchPrompt(prompt)) return prompt;

  const task = prompt.trimStart().slice(DEEP_RESEARCH_TAG.length).trim();
  const stages = resolveResearchStages(stageConfigs);
  const stageLines = stages.flatMap((stage, index) => {
    const goal = stage.goal.trim();
    const lines = [`${index + 1}. ${stage.title.trim()}${goal ? ` — ${goal}` : ""}`];
    const suggestion = stageSuggestionLabel(stage, providers);
    if (suggestion) {
      lines.push(
        `   Suggested for this stage: ${suggestion} — a suggestion only; hand off or use its CLI if appropriate. Never claim it ran unless it did.`,
      );
    }
    return lines;
  });
  const parallelNotes = describeParallelStageNotes(stages);
  const providerLines =
    providers.length > 0
      ? providers.map(
          (provider) =>
            `- ${provider.name}: CLI \`${provider.cli}\`; models: ${provider.models.join(", ")}`,
        )
      : ["- No additional ready provider was detected. Continue with the current model only."];
  const roleLines = AGENT_ROLES.map(([name, responsibility], index) => {
    const provider = providers[index % Math.max(providers.length, 1)];
    return `- ${name}: ${responsibility}${provider ? ` (${provider.name})` : ""}`;
  });

  return [
    DEEP_RESEARCH_TAG,
    "",
    "Act as the research lead for this d4research thread. The current thread and selected model remain authoritative.",
    "Use only the agents needed for the task; run at most three delegated agents concurrently and never recursively delegate.",
    "Track progress in your plan/todo tool so the user can follow it without asking: create one step per stage below using its exact title, mark exactly one step in progress at a time, and complete it before moving on.",
    "Drop or add stages when the task warrants it, and name any delegated agent in the step it belongs to.",
    "",
    "Stages:",
    ...stageLines,
    ...(parallelNotes.length > 0 ? ["", ...parallelNotes] : []),
    "",
    "Post a short status after each research stage. Preserve links, file paths, commands, and uncertainty in the synthesis.",
    "Store compact shared findings with `memory_remember` using connector `local`, and retrieve them with `memory_search` before each handoff.",
    "When another provider is useful, use its installed CLI below or ask the user to use Change provider; do not claim a handoff ran unless it did.",
    "",
    "Suggested research roles:",
    ...roleLines,
    "",
    "Ready provider CLIs:",
    ...providerLines,
    "",
    "Research task:",
    task || "Ask the user for the research question before delegating.",
  ].join("\n");
}
