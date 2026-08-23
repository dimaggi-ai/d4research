import {
  RESEARCH_DELEGATION_BUDGET_PER_TURN,
  RESEARCH_STEP_VISIT_LIMIT,
  type DevSettings,
  type PipelineTargetPolicy,
  type ResearchPromptFile,
  type ResearchScenario,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@d4research/contracts";

export const DEV_TRIGGER_PREFIX = "!dev";
export const DEFAULT_DEV_SCENARIO_NAME = "default";
export const DEV_PROTOCOL_SENTINEL = "Dev pipeline protocol (non-negotiable):";
export const DEV_PIPELINE_SENTINEL = "PIPELINE (verbatim):";
export const PIPELINE_DIRECTIVE_MAX_COUNT = 64;
export const DEV_PIPELINE_OPTION_EVENT_PREFIX = "options:dev-pipeline:";

const DEV_TRIGGER_REGEX = /^\s*!dev(?::([a-z0-9][a-z0-9-]*))?(?=\s|$)/i;
const DIRECTIVE_REGEX = /!([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9._:/-]*)/g;
const PROMPT_FILE_SUFFIX_REGEX = /:([^:\s]+\.(?:md|markdown|txt))$/iu;
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Providers whose adapters inject the per-thread MCP credential. */
const PIPELINE_ORCHESTRATOR_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
]);

export function providerDriverSupportsPipelineOrchestration(driver: string): boolean {
  return PIPELINE_ORCHESTRATOR_DRIVERS.has(driver);
}

const CLI_BY_DRIVER: Readonly<Record<string, string>> = {
  agy: "agy",
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  grok: "grok",
  junie: "junie",
  opencode: "opencode",
};

export interface DevProviderCandidate {
  readonly instanceId: string;
  readonly name: string;
  readonly cli: string;
  readonly models: ReadonlyArray<string>;
}

export interface DevTrigger {
  readonly scenarioName: string | null;
  readonly task: string;
}

export interface DevPipelineOptionSelection {
  readonly scenarioName: string | null;
}

/** Parses the mobile options-menu event without treating unrelated actions as pipelines. */
export function parseDevPipelineOptionEvent(event: string): DevPipelineOptionSelection | null {
  if (!event.startsWith(DEV_PIPELINE_OPTION_EVENT_PREFIX)) return null;
  const value = event.slice(DEV_PIPELINE_OPTION_EVENT_PREFIX.length);
  if (value === "off") return { scenarioName: null };
  return /^[a-z0-9][a-z0-9-]*$/u.test(value) ? { scenarioName: value } : null;
}

export function devPipelineControlKind(
  showInteractionModeToggle: boolean,
  interactionMode: ProviderInteractionMode,
): "plan-exit" | "pipeline-picker" {
  return showInteractionModeToggle && interactionMode === "plan" ? "plan-exit" : "pipeline-picker";
}

export function shouldExitPlanForDevPipelineSelection(
  interactionMode: ProviderInteractionMode,
  scenarioName: string | null,
): boolean {
  return interactionMode === "plan" && scenarioName !== null;
}

interface DevDirective {
  readonly raw: string;
  readonly provider: string;
  readonly model: string;
  readonly promptFile: string | undefined;
}

type DevTarget = { readonly candidate: DevProviderCandidate; readonly model: string };

function modelFamily(model: string): string {
  const normalized = model.toLowerCase();
  for (const family of [
    "claude",
    "gpt",
    "gemini",
    "grok",
    "kimi",
    "glm",
    "nemotron",
    "qwen",
    "deepseek",
  ]) {
    if (normalized.startsWith(family)) return family;
  }
  return normalized.split(/[.:/-]/u)[0] ?? normalized;
}

function providerPreferenceRank(
  candidate: DevProviderCandidate,
  providerPreferences: ReadonlyArray<string>,
): number {
  const values = new Set(
    [candidate.instanceId, candidate.name, candidate.cli].map((value) => value.toLowerCase()),
  );
  const rank = providerPreferences.findIndex((preferred) => values.has(preferred.toLowerCase()));
  return rank < 0 ? providerPreferences.length : rank;
}

function findPreferredTarget(
  candidates: ReadonlyArray<DevProviderCandidate>,
  modelPreferences: ReadonlyArray<string>,
  options: {
    readonly excludedKeys?: ReadonlySet<string>;
    readonly excludedInstanceIds?: ReadonlySet<string>;
    readonly excludedFamilies?: ReadonlySet<string>;
    readonly providerPreferences?: ReadonlyArray<string>;
  } = {},
): DevTarget | null {
  const excludedKeys = options.excludedKeys ?? new Set<string>();
  const excludedInstanceIds = options.excludedInstanceIds ?? new Set<string>();
  const excludedFamilies = options.excludedFamilies ?? new Set<string>();
  const providerPreferences = options.providerPreferences ?? [];
  const eligible = (candidate: DevProviderCandidate, model: string) =>
    !excludedKeys.has(`${candidate.instanceId}:${model}`) &&
    !excludedInstanceIds.has(candidate.instanceId) &&
    !excludedFamilies.has(modelFamily(model));
  const rankedCandidates = [...candidates].sort(
    (left, right) =>
      providerPreferenceRank(left, providerPreferences) -
      providerPreferenceRank(right, providerPreferences),
  );
  for (const preferred of modelPreferences) {
    for (const candidate of rankedCandidates) {
      const model = candidate.models.find((slug) => slug.toLowerCase() === preferred.toLowerCase());
      if (model !== undefined && eligible(candidate, model)) return { candidate, model };
    }
  }
  for (const candidate of rankedCandidates) {
    for (const model of candidate.models) {
      if (eligible(candidate, model)) return { candidate, model };
    }
  }
  return null;
}

const targetKey = (target: DevTarget): string => `${target.candidate.instanceId}:${target.model}`;
const targetDirective = (target: DevTarget): string =>
  `!${target.candidate.instanceId}:${target.model}`;

export function buildDefaultDevPipelinePrompt(
  candidates: ReadonlyArray<DevProviderCandidate>,
): string {
  const usableCandidates = candidates.filter((candidate) => candidate.models.length > 0);
  if (usableCandidates.length === 0) {
    return `STEP 1 — PLAN
Determine the root cause, the smallest correct fix, the files to touch, and the command that proves it. Do not edit until the plan is concrete.

STEP 2 — BUILD
Apply the minimal change yourself. Preserve unrelated work and cover the root cause, not merely the symptom.

STEP 3 — REVIEW + VERIFY
Review the resulting diff adversarially, run the narrowest meaningful verification command, and paste its real output. Fix a blocking review finding before reporting done.

RUN STATE
Report plan, files changed, review verdict, and verification outcome. Never imply another model ran.`;
  }

  const used = new Set<string>();
  const planner = findPreferredTarget(
    usableCandidates,
    ["claude-opus-5", "claude-fable-5", "gpt-5.6-sol", "gpt-5.6-terra"],
    { providerPreferences: ["claudeAgent", "claude", "junie", "codex"] },
  )!;
  used.add(targetKey(planner));
  const builder =
    findPreferredTarget(
      usableCandidates,
      ["grok-4.5", "kimi-k2.7-code:cloud", "gpt-5.6-terra", "gpt-5.6-sol"],
      {
        excludedKeys: used,
        excludedFamilies: new Set([modelFamily(planner.model)]),
        providerPreferences: ["junie", "ollama", "codex", "claudeAgent"],
      },
    ) ?? planner;
  used.add(targetKey(builder));
  const reviewer =
    findPreferredTarget(
      usableCandidates,
      ["gpt-5.6-terra", "gpt-5.6-sol", "claude-opus-5", "gemini-3.1-pro-preview"],
      {
        excludedKeys: used,
        excludedFamilies: new Set([modelFamily(builder.model)]),
        providerPreferences: ["codex", "junie", "claudeAgent", "ollama"],
      },
    ) ?? planner;
  used.add(targetKey(reviewer));
  const secondOpinion = findPreferredTarget(
    usableCandidates,
    ["gemini-3.1-pro-preview", "claude-opus-5", "gpt-5.6-sol"],
    {
      excludedKeys: used,
      excludedFamilies: new Set([
        modelFamily(planner.model),
        modelFamily(builder.model),
        modelFamily(reviewer.model),
      ]),
      providerPreferences: ["junie", "claudeAgent", "codex", "ollama"],
    },
  );

  const fallbackFor = (primary: DevTarget): DevTarget | null =>
    findPreferredTarget(
      usableCandidates,
      ["gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5", "glm-5.2:cloud"],
      {
        excludedKeys: new Set([targetKey(primary)]),
        excludedInstanceIds: new Set([primary.candidate.instanceId]),
        providerPreferences: ["codex", "junie", "claudeAgent", "ollama"],
      },
    );
  const step = (name: string, primary: DevTarget, request: string): string => {
    const fallback = fallbackFor(primary);
    return `${name}
Directive: ${targetDirective(primary)}
${fallback === null ? "FALLBACK: no alternate ready target; report failure and continue safely." : `FALLBACK directive: ${targetDirective(fallback)}`}
${request}`;
  };

  return [
    step(
      "STEP 1 — PLAN",
      planner,
      "Ask for root cause, the smallest correct fix, exact files, risks, and the verification command. No code yet.",
    ),
    step(
      "STEP 2 — BUILD",
      builder,
      "Send the approved plan and current file contents. Require a complete diff covering every planned file.",
    ),
    step(
      "STEP 3 — REVIEW",
      reviewer,
      "Send the plan and proposed diff. Require an explicit verdict, nearby regressions, and a verification command.",
    ),
    ...(secondOpinion === null
      ? []
      : [
          step(
            "STEP 3b — SECOND OPINION (only when review flags a risk)",
            secondOpinion,
            "Send the objection and diff. Require agree/disagree plus the cheapest correct resolution. This target shares no model family with the primary review target.",
          ),
        ]),
    "APPLY\nApply the reviewed change yourself, run verification, and paste real output. End with RUN STATE listing every target, visit count, and outcome.",
  ].join("\n\n");
}

export function parseDevTrigger(prompt: string): DevTrigger | null {
  const match = DEV_TRIGGER_REGEX.exec(prompt);
  if (!match) return null;
  return {
    scenarioName: match[1]?.toLowerCase() ?? null,
    task: prompt.slice((match.index ?? 0) + match[0].length).trim(),
  };
}

export function stripDevTrigger(prompt: string): string {
  return parseDevTrigger(prompt)?.task ?? prompt;
}

export function activeDevScenarioName(prompt: string): string | null {
  const trigger = parseDevTrigger(prompt);
  return trigger ? (trigger.scenarioName ?? DEFAULT_DEV_SCENARIO_NAME) : null;
}

export function applyDevTrigger(prompt: string, scenarioName: string | null): string {
  const task = stripDevTrigger(prompt);
  if (scenarioName === null) return task;
  const trigger = `${DEV_TRIGGER_PREFIX}:${scenarioName}`;
  return task ? `${trigger} ${task}` : `${trigger} `;
}

export function listDevScenarios(
  settings: Pick<DevSettings, "scenarios"> | undefined,
  candidates: ReadonlyArray<DevProviderCandidate> = [],
): ReadonlyArray<ResearchScenario> {
  if (settings && settings.scenarios.length > 0) return settings.scenarios;
  return [
    {
      name: DEFAULT_DEV_SCENARIO_NAME,
      pipelinePrompt: buildDefaultDevPipelinePrompt(candidates),
      promptFiles: [],
    },
  ];
}

export function findDevScenario(
  settings: Pick<DevSettings, "scenarios" | "activeScenario"> | undefined,
  scenarioName: string | null,
  candidates: ReadonlyArray<DevProviderCandidate> = [],
): ResearchScenario | null {
  const scenarios = listDevScenarios(settings, candidates);
  if (scenarioName !== null) {
    return scenarios.find((scenario) => scenario.name === scenarioName) ?? null;
  }
  return (
    scenarios.find((scenario) => scenario.name === settings?.activeScenario) ?? scenarios[0] ?? null
  );
}

function parseDirectives(text: string): ReadonlyArray<DevDirective> {
  const directives: Array<DevDirective> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(DIRECTIVE_REGEX)) {
    const provider = match[1] ?? "";
    let model = (match[2] ?? "").replace(/[.,;:!?]+$/u, "");
    let promptFile: string | undefined;
    const fileMatch = PROMPT_FILE_SUFFIX_REGEX.exec(model);
    if (fileMatch?.[1] !== undefined) {
      promptFile = fileMatch[1];
      model = model.slice(0, -fileMatch[0].length);
    }
    if (!model) continue;
    const raw = `!${provider}:${model}${promptFile === undefined ? "" : `:${promptFile}`}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    directives.push({ raw, provider, model, promptFile });
    if (directives.length >= PIPELINE_DIRECTIVE_MAX_COUNT) break;
  }
  return directives;
}

function providerMatchRank(candidate: DevProviderCandidate, needle: string): number | null {
  if (candidate.instanceId.toLowerCase() === needle) return 0;
  if (candidate.name.toLowerCase() === needle) return 1;
  if (candidate.cli.toLowerCase() === needle) return 2;
  if (candidate.name.toLowerCase().startsWith(needle)) return 3;
  return null;
}

function resolveDirective(
  directive: DevDirective,
  candidates: ReadonlyArray<DevProviderCandidate>,
  promptFiles: ReadonlyArray<ResearchPromptFile>,
): string {
  const needle = directive.provider.toLowerCase();
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: providerMatchRank(candidate, needle) }))
    .filter(
      (entry): entry is { candidate: DevProviderCandidate; rank: number } => entry.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank);
  const best = ranked.filter((entry) => entry.rank === ranked[0]?.rank);
  if (best.length !== 1) {
    return `- \`${directive.raw}\` → UNRESOLVED: ${
      best.length === 0
        ? `no ready provider matches "${directive.provider}"`
        : `provider is ambiguous: ${best.map((entry) => entry.candidate.name).join(", ")}`
    }`;
  }
  const provider = best[0]!.candidate;
  const modelNeedle = directive.model.toLowerCase();
  const exact = provider.models.find((model) => model.toLowerCase() === modelNeedle);
  const models = exact
    ? [exact]
    : provider.models.filter((model) => model.toLowerCase().includes(modelNeedle));
  if (models.length !== 1) {
    return `- \`${directive.raw}\` → UNRESOLVED: model ${
      models.length === 0 ? "not found" : `is ambiguous: ${models.join(", ")}`
    }`;
  }
  if (
    directive.promptFile !== undefined &&
    !promptFiles.some((file) => file.name === directive.promptFile)
  ) {
    return `- \`${directive.raw}\` → UNRESOLVED: prompt file "${directive.promptFile}" is not attached`;
  }
  return `- \`${directive.raw}\` → target \`${provider.instanceId}:${models[0]}\`${
    directive.promptFile === undefined ? "" : ` with prompt file \`${directive.promptFile}\``
  }`;
}

export function deriveDevProviderCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<DevProviderCandidate> {
  return providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status === "ready" &&
        provider.availability !== "unavailable",
    )
    .map((provider) => ({
      instanceId: String(provider.instanceId),
      name: provider.displayName ?? String(provider.instanceId),
      cli: CLI_BY_DRIVER[String(provider.driver)] ?? String(provider.driver),
      models: provider.models
        .map((model) => model.slug)
        .filter((model) => MODEL_SLUG_REGEX.test(model)),
    }))
    .filter((provider) => provider.models.length > 0);
}

export function expandDevPipelinePrompt(
  prompt: string,
  settings: Pick<DevSettings, "scenarios" | "activeScenario"> | undefined,
  candidates: ReadonlyArray<DevProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  if (prompt.includes(DEV_PROTOCOL_SENTINEL) && prompt.includes(DEV_PIPELINE_SENTINEL)) {
    return prompt;
  }
  const trigger = parseDevTrigger(prompt);
  if (!trigger) return prompt;
  const scenario = findDevScenario(settings, trigger.scenarioName, candidates);
  if (!scenario) {
    return `${DEV_TRIGGER_PREFIX}\n\nNo dev pipeline named \`${trigger.scenarioName}\` exists. Available: ${listDevScenarios(
      settings,
      candidates,
    )
      .map((entry) => entry.name)
      .join(
        ", ",
      )}. Do not improvise a pipeline; stop.\n\nTask:\n${trigger.task || "None provided."}`;
  }
  if (!scenario.pipelinePrompt.trim()) {
    return `${DEV_TRIGGER_PREFIX}\n\nThe dev pipeline \`${scenario.name}\` has no steps. Stop and ask the user to configure it.\n\nTask:\n${trigger.task || "None provided."}`;
  }
  const targets = parseDirectives(scenario.pipelinePrompt).map((directive) =>
    resolveDirective(directive, candidates, scenario.promptFiles),
  );
  return [
    `${DEV_TRIGGER_PREFIX}:${scenario.name}`,
    "",
    `You are running the \`${scenario.name}\` dev pipeline in this thread. Follow its steps exactly, in order. You apply the final change yourself — the delegates advise, you edit.`,
    "",
    DEV_PROTOCOL_SENTINEL,
    "1. TRACE — Keep one plan entry per pipeline step. Begin every status with `[step N | visit K]`.",
    `2. DELEGATE — Call \`research_delegate\` with the resolved target, \`pipelineKind: "dev"\`, \`scenario: "${scenario.name}"\`, and current \`step\` and \`visit\`. Never simulate a delegate.`,
    targetPolicy === "labeled-fallback"
      ? "3. TARGET POLICY — Labeled fallback is enabled. Pass the step's explicitly authored FALLBACK directive in `fallbackTargets`. The tool identifies requested and resolved targets; always name the actual model that ran."
      : "3. TARGET POLICY — Exact targets only. Do not pass or invent fallbacks; report an unavailable target as FAILED.",
    `4. BUDGET — The server enforces ${RESEARCH_DELEGATION_BUDGET_PER_TURN} calls per run and ${RESEARCH_STEP_VISIT_LIMIT} visits per step-target.`,
    "5. HONESTY — A delegate that timed out, refused, returned empty, or answered with intent only is reported as FAILED. Never invent its answer.",
    "6. RUN STATE — End with requested target, actual resolved target, whether a labeled fallback was used, visits, and outcome for every step, including failed dependencies.",
    "",
    "Delegation targets referenced by the pipeline:",
    ...(targets.length > 0 ? targets : ["- No delegation targets. Execute with this model only."]),
    "",
    DEV_PIPELINE_SENTINEL,
    scenario.pipelinePrompt.trim(),
    "",
    "Task:",
    trigger.task || "Ask the user what to build or fix before starting.",
  ].join("\n");
}
