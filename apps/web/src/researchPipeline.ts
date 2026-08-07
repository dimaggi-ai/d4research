import type { ResearchPromptFile, ResearchSettings } from "@t3tools/contracts";
import { RESEARCH_DELEGATION_BUDGET_PER_TURN, RESEARCH_STEP_VISIT_LIMIT } from "@t3tools/contracts";

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

export interface ResearchProviderCandidate {
  readonly instanceId: string;
  readonly name: string;
  readonly cli: string;
  readonly models: ReadonlyArray<string>;
}

// Discovery can yield malformed slugs (a CLI's spinner frames captured as a
// model name). They are unusable as delegation targets and would bloat the
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
      instanceId: String(entry.instanceId),
      name: entry.displayName,
      cli: CLI_BY_DRIVER[entry.driverKind] ?? entry.driverKind,
      models: sanitizeResearchModelSlugs(entry.models.map((model) => model.slug)),
    }))
    .filter((provider) => provider.models.length > 0);
}

// ── Directives ─────────────────────────────────────────────────────────────

/**
 * One `!provider:model[:file.md]` reference found in the pipeline prompt.
 * `promptFile` is only split off when the trailing segment looks like a file
 * name — model slugs legitimately contain colons (`glm-5.2:cloud`), so the
 * split is by suffix, not by position.
 */
export interface ResearchModelDirective {
  readonly raw: string;
  readonly provider: string;
  readonly model: string;
  readonly promptFile: string | undefined;
}

const DIRECTIVE_REGEX = /!([A-Za-z0-9][A-Za-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._:/-]*)/g;
const PROMPT_FILE_SUFFIX_REGEX = /:([^:\s]+\.(?:md|markdown|txt))$/iu;

export function parseResearchDirectives(text: string): ReadonlyArray<ResearchModelDirective> {
  const directives: Array<ResearchModelDirective> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(DIRECTIVE_REGEX)) {
    const provider = match[1] ?? "";
    // Directives live inside prose — "fan out to !claude:fable." captures the
    // sentence's period. Trailing punctuation is never part of a model slug or
    // file name, so strip it before splitting.
    let model = (match[2] ?? "").replace(/[.,;:!?]+$/u, "");
    let promptFile: string | undefined;
    const fileMatch = PROMPT_FILE_SUFFIX_REGEX.exec(model);
    if (fileMatch?.[1] !== undefined) {
      promptFile = fileMatch[1];
      model = model.slice(0, -fileMatch[0].length);
    }
    if (!model) continue;
    // Canonical form, without whatever punctuation trailed it in prose.
    const raw = `!${provider}:${model}${promptFile !== undefined ? `:${promptFile}` : ""}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    directives.push({ raw, provider, model, promptFile });
  }
  return directives;
}

export type ResearchDirectiveResolution =
  | {
      readonly directive: ResearchModelDirective;
      readonly ok: true;
      readonly instanceId: string;
      readonly providerName: string;
      readonly model: string;
    }
  | { readonly directive: ResearchModelDirective; readonly ok: false; readonly error: string };

/**
 * Resolves a directive against ready providers and attached prompt files.
 * Provider matches by display name or CLI name prefix, case-insensitive.
 * Model matches exactly first, then as a unique substring — `fable` finds
 * `claude-fable-5`, but an ambiguous fragment is an error, never a guess.
 */
export function resolveResearchDirective(
  directive: ResearchModelDirective,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  promptFiles: ReadonlyArray<ResearchPromptFile>,
): ResearchDirectiveResolution {
  const providerNeedle = directive.provider.toLowerCase();
  const provider = candidates.find((candidate) => {
    const name = candidate.name.toLowerCase();
    return (
      name === providerNeedle ||
      name.startsWith(providerNeedle) ||
      candidate.cli.toLowerCase() === providerNeedle
    );
  });
  if (!provider) {
    return {
      directive,
      ok: false,
      error: `No ready provider matches "${directive.provider}". Ready: ${
        candidates.map((candidate) => candidate.name).join(", ") || "none"
      }.`,
    };
  }
  const modelNeedle = directive.model.toLowerCase();
  const exact = provider.models.find((model) => model.toLowerCase() === modelNeedle);
  const fuzzy = exact
    ? [exact]
    : provider.models.filter((model) => model.toLowerCase().includes(modelNeedle));
  if (fuzzy.length === 0) {
    return {
      directive,
      ok: false,
      error: `${provider.name} has no model matching "${directive.model}". Available: ${provider.models.join(", ")}.`,
    };
  }
  if (fuzzy.length > 1) {
    return {
      directive,
      ok: false,
      error: `"${directive.model}" is ambiguous for ${provider.name}: ${fuzzy.join(", ")}.`,
    };
  }
  if (
    directive.promptFile !== undefined &&
    !promptFiles.some((file) => file.name === directive.promptFile)
  ) {
    return {
      directive,
      ok: false,
      error: `Prompt file "${directive.promptFile}" is not attached in Settings → Research.`,
    };
  }
  return {
    directive,
    ok: true,
    instanceId: provider.instanceId,
    providerName: provider.name,
    model: fuzzy[0] as string,
  };
}

export function resolveResearchDirectives(
  text: string,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  promptFiles: ReadonlyArray<ResearchPromptFile>,
): ReadonlyArray<ResearchDirectiveResolution> {
  return parseResearchDirectives(text).map((directive) =>
    resolveResearchDirective(directive, candidates, promptFiles),
  );
}

// ── Directive autocomplete ─────────────────────────────────────────────────

export interface DirectiveSuggestion {
  /** Full replacement for the active `!` token, e.g. `!claude:claude-fable-5`. */
  readonly insert: string;
  /** Short label for the list row. */
  readonly label: string;
  /** Where the active token starts in the text (the `!` itself). */
  readonly tokenStart: number;
}

const ACTIVE_DIRECTIVE_TOKEN_REGEX = /!([A-Za-z0-9-]*)((?::[A-Za-z0-9._:/-]*)?)$/;
const MAX_DIRECTIVE_SUGGESTIONS = 12;

/**
 * Suggestions for the `!` token the caret is inside, so pipeline authors never
 * copy targets by hand: `!` lists providers, `!provider:` lists that
 * provider's models, and a complete `!provider:model:` offers the attached
 * prompt files. Returns an empty list when the caret is not in a directive.
 */
export function deriveDirectiveSuggestions(
  textBeforeCaret: string,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  promptFiles: ReadonlyArray<ResearchPromptFile>,
): ReadonlyArray<DirectiveSuggestion> {
  const match = ACTIVE_DIRECTIVE_TOKEN_REGEX.exec(textBeforeCaret);
  if (!match) return [];
  const tokenStart = textBeforeCaret.length - match[0].length;
  const providerPart = match[1] ?? "";
  const rest = match[2] ?? "";

  // No colon yet — complete the provider.
  if (rest.length === 0) {
    const needle = providerPart.toLowerCase();
    return candidates
      .filter(
        (candidate) =>
          candidate.cli.toLowerCase().startsWith(needle) ||
          candidate.name.toLowerCase().startsWith(needle),
      )
      .slice(0, MAX_DIRECTIVE_SUGGESTIONS)
      .map((candidate) => ({
        insert: `!${candidate.cli}:`,
        label: `${candidate.name} — ${candidate.models.length} models`,
        tokenStart,
      }));
  }

  const provider = candidates.find(
    (candidate) =>
      candidate.cli.toLowerCase() === providerPart.toLowerCase() ||
      candidate.name.toLowerCase() === providerPart.toLowerCase(),
  );
  if (!provider) return [];
  const afterProvider = rest.slice(1); // drop the leading ':'

  // A full model followed by ':' — offer the attached prompt files.
  const modelExact = provider.models.find(
    (model) =>
      afterProvider.toLowerCase() === `${model.toLowerCase()}:` ||
      afterProvider.toLowerCase().startsWith(`${model.toLowerCase()}:`),
  );
  if (modelExact) {
    const filePrefix = afterProvider.slice(modelExact.length + 1).toLowerCase();
    return promptFiles
      .filter((file) => file.name.toLowerCase().startsWith(filePrefix))
      .slice(0, MAX_DIRECTIVE_SUGGESTIONS)
      .map((file) => ({
        insert: `!${provider.cli}:${modelExact}:${file.name}`,
        label: `${modelExact} + ${file.name}`,
        tokenStart,
      }));
  }

  // Otherwise complete the model.
  const modelNeedle = afterProvider.toLowerCase();
  return provider.models
    .filter((model) => model.toLowerCase().includes(modelNeedle))
    .slice(0, MAX_DIRECTIVE_SUGGESTIONS)
    .map((model) => ({
      insert: `!${provider.cli}:${model}`,
      label: model,
      tokenStart,
    }));
}

// ── Orchestrator prompt ────────────────────────────────────────────────────

export interface ResearchPipelineInput {
  readonly pipelinePrompt: string;
  readonly promptFiles: ReadonlyArray<ResearchPromptFile>;
}

export function researchPipelineFromSettings(
  settings: Pick<ResearchSettings, "pipelinePrompt" | "promptFiles"> | undefined,
): ResearchPipelineInput {
  return {
    pipelinePrompt: settings?.pipelinePrompt ?? "",
    promptFiles: settings?.promptFiles ?? [],
  };
}

/**
 * Compiles the orchestrator turn for a `#deep-research` prompt. The pipeline
 * from Settings → Research is quoted verbatim and framed with a strict
 * execution protocol: step-by-step tracing through the plan tool, delegation
 * only through `research_delegate`, and explicit loop budgets so a cyclic
 * pipeline (fan out → summarize → argue → regenerate → summarize again)
 * terminates instead of orbiting. Returns the prompt unchanged when it is not
 * a research prompt.
 */
export function expandResearchPipelinePrompt(
  prompt: string,
  pipeline: ResearchPipelineInput,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
): string {
  if (!isDeepResearchPrompt(prompt)) return prompt;

  const task = prompt.trimStart().slice(DEEP_RESEARCH_TAG.length).trim();
  const pipelinePrompt = pipeline.pipelinePrompt.trim();
  const resolutions = resolveResearchDirectives(pipelinePrompt, candidates, pipeline.promptFiles);
  const targetLines = resolutions.map((resolution) =>
    resolution.ok
      ? `- \`${resolution.directive.raw}\` → target \`${resolution.instanceId}:${resolution.model}\`${
          resolution.directive.promptFile !== undefined
            ? ` with prompt file \`${resolution.directive.promptFile}\``
            : ""
        }`
      : `- \`${resolution.directive.raw}\` → UNRESOLVED: ${resolution.error} Report this to the user in your first status instead of guessing a substitute.`,
  );
  const fileLines = pipeline.promptFiles.map((file) => `- \`${file.name}\``);

  if (!pipelinePrompt) {
    return [
      DEEP_RESEARCH_TAG,
      "",
      "No research pipeline is configured. Tell the user to define one in Settings → Research (orchestrator model, pipeline prompt, prompt files), then stop. Do not improvise a pipeline.",
      "",
      "Research task:",
      task || "None provided.",
    ].join("\n");
  }

  return [
    DEEP_RESEARCH_TAG,
    "",
    "You are the research orchestrator for this thread. The PIPELINE below is authoritative: follow its steps exactly, in order, including any loops it defines. Do not add, skip, merge, or reorder steps.",
    "",
    "Execution protocol (non-negotiable):",
    "1. TRACE — Maintain the plan tool as your step ledger: one entry per pipeline step titled `Step N: <title>`. Exactly one entry is in-progress at any time. On a revisit, append ` (visit K)` to the entry text. Begin every message with the marker `[step N | visit K]`.",
    `2. DELEGATE — A \`!provider:model[:file.md]\` directive is executed only by calling the \`research_delegate\` tool. Its \`target\` argument must be the resolved \`instanceId:model\` string from the "Delegation targets" list below, copied exactly — never the \`!\` directive itself. Pass your request as \`prompt\`, the file name as \`promptFileName\` when the directive names one, and the current \`step\`/\`visit\`. Never claim a delegation ran unless the tool returned its answer. Never delegate to yourself recursively.`,
    `3. LOOP GUARD — A step may run at most ${RESEARCH_STEP_VISIT_LIMIT} visits and the whole turn has a hard budget of ${RESEARCH_DELEGATION_BUDGET_PER_TURN} delegations, enforced by the server. When a guard trips, stop looping, synthesize from what you have, and state plainly which loop was cut and why.`,
    "4. HONESTY — Preserve links, file paths, commands, disagreements, and uncertainty when summarizing delegate answers. A delegate that failed or timed out is reported as failed, not paraphrased into a result.",
    "",
    "Delegation targets referenced by the pipeline:",
    ...(targetLines.length > 0
      ? targetLines
      : [
          "- The pipeline references no `!provider:model` targets. Execute it with this model only.",
        ]),
    "",
    "Prompt files attached in Settings → Research (contents are inlined server-side when a directive names them — do not paste them yourself):",
    ...(fileLines.length > 0 ? fileLines : ["- none"]),
    "",
    "PIPELINE (verbatim):",
    pipelinePrompt,
    "",
    "Research task:",
    task || "Ask the user for the research question before starting the pipeline.",
  ].join("\n");
}
