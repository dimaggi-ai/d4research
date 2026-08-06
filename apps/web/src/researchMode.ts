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
  readonly name: string;
  readonly cli: string;
  readonly models: ReadonlyArray<string>;
}

/**
 * Stage names the research lead is asked to track as plan steps. Keeping them
 * fixed lets the composer render deterministic progress instead of parsing
 * free-form status prose.
 */
export const RESEARCH_STAGES = [
  "Scope the question",
  "Gather primary evidence",
  "Test competing explanations",
  "Challenge findings",
  "Synthesize the answer",
] as const;

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

export function deriveResearchProviderCandidates(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ResearchProviderCandidate> {
  return entries
    .filter(
      (entry) =>
        entry.enabled && entry.isAvailable && entry.status === "ready" && entry.models.length > 0,
    )
    .map((entry) => ({
      name: entry.displayName,
      cli: CLI_BY_DRIVER[entry.driverKind] ?? entry.driverKind,
      models: sanitizeResearchModelSlugs(entry.models.map((model) => model.slug)),
    }))
    .filter((provider) => provider.models.length > 0);
}

export function expandDeepResearchPrompt(
  prompt: string,
  providers: ReadonlyArray<ResearchProviderCandidate>,
): string {
  if (!isDeepResearchPrompt(prompt)) return prompt;

  const task = prompt.trimStart().slice(DEEP_RESEARCH_TAG.length).trim();
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
    "Act as the research lead for this d2research thread. The current thread and selected model remain authoritative.",
    "Use only the agents needed for the task; run at most three delegated agents concurrently and never recursively delegate.",
    "Track progress in your plan/todo tool so the user can follow it without asking: create one step per stage before starting, mark exactly one step in progress at a time, and complete it before moving on.",
    `Stages: ${RESEARCH_STAGES.join(" → ")}. Drop or add stages when the task warrants it, and name any delegated agent in the step it belongs to.`,
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
