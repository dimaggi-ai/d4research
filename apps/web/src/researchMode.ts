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
      models: entry.models.map((model) => model.slug),
    }));
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
    "Act as the research lead for this T3Research thread. The current thread and selected model remain authoritative.",
    "Use only the agents needed for the task; run at most three delegated agents concurrently and never recursively delegate.",
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
