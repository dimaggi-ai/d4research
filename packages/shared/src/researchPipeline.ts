import type {
  PipelineTargetPolicy,
  ResearchPromptFile,
  ResearchScenario,
  ResearchSettings,
  ServerProvider,
} from "@d4research/contracts";
import {
  canStartProviderTurn,
  RESEARCH_DELEGATION_BUDGET_PER_TURN,
  RESEARCH_STEP_VISIT_LIMIT,
  STARTER_RESEARCH_SCENARIO,
} from "@d4research/contracts";
import { parseDevTrigger, stripDevTrigger } from "./devPipeline.ts";
import { sha256Hex } from "./hash.ts";

// The legacy `#deep-research` spelling is still parsed (see the regex below) so
// old threads and muscle memory keep working, but nothing writes it any more —
// every insertion point emits `!research:<scenario>`. It is deliberately not a
// named constant: an exported tag invites re-wiring a control back to it.
export const RESEARCH_TRIGGER_PREFIX = "!research";
export const DEFAULT_RESEARCH_SCENARIO_NAME = "default";

// `!research:blog task…`, `!research task…`, or legacy `#deep-research[:name]`.
const RESEARCH_TRIGGER_REGEX =
  /^\s*(?:!research|#deep-research)(?::([a-z0-9][a-z0-9-]*))?(?=\s|$)/i;

export interface ResearchTrigger {
  /** Scenario the trigger names, or null for the configured default. */
  readonly scenarioName: string | null;
  /** The research task with the trigger stripped. */
  readonly task: string;
}

export interface ResearchRunManifestStep {
  readonly number: number;
  readonly title: string;
  readonly delegation: "local" | "planned" | "skipped-no-target";
  readonly targets: ReadonlyArray<string>;
}

export interface ResearchRunManifest {
  readonly scenario: string;
  readonly task: string;
  readonly pipelineHash: string;
  readonly targetPolicy: PipelineTargetPolicy;
  readonly steps: ReadonlyArray<ResearchRunManifestStep>;
  readonly targets: ReadonlyArray<
    | { readonly directive: string; readonly status: "resolved"; readonly target: string }
    | { readonly directive: string; readonly status: "unresolved"; readonly error: string }
  >;
  readonly budget: {
    readonly maxDelegations: number;
    readonly maxVisitsPerStep: number;
  };
}

export function parseResearchTrigger(prompt: string): ResearchTrigger | null {
  const match = RESEARCH_TRIGGER_REGEX.exec(prompt);
  if (!match) return null;
  return {
    scenarioName: match[1]?.toLowerCase() ?? null,
    task: prompt.slice((match.index ?? 0) + match[0].length).trim(),
  };
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

export interface ResearchProviderCandidate {
  readonly instanceId: string;
  readonly name: string;
  readonly cli: string;
  readonly models: ReadonlyArray<string>;
}

export interface ResearchProviderEntry {
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly status: string;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
  readonly instanceId: string | { readonly toString: () => string };
  readonly displayName: string;
  readonly driverKind: string;
}

// Discovery can yield malformed slugs (a CLI's spinner frames captured as a
// model name). They are unusable as delegation targets and would bloat the
// prompt, so keep only well-formed identifiers.
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export function sanitizeResearchModelSlugs(models: ReadonlyArray<string>): ReadonlyArray<string> {
  // The catalog itself never reaches the prompt; only named directives do.
  // Truncating here silently makes valid models unresolvable.
  return models.filter((model) => MODEL_SLUG_REGEX.test(model));
}

export function isDeepResearchPrompt(prompt: string): boolean {
  return parseResearchTrigger(prompt) !== null;
}

/**
 * Drops a leading research trigger, keeping the task the user already typed.
 * Slicing a fixed tag length is wrong here — triggers vary in length
 * (`!research`, `!research:blog`, `#deep-research`).
 */
export function stripResearchTrigger(prompt: string): string {
  return parseResearchTrigger(prompt)?.task ?? prompt;
}

/** Arm research after removing either pipeline mode from the existing task. */
export function applyResearchTrigger(prompt: string, scenarioName: string): string {
  const task = stripDevTrigger(stripResearchTrigger(prompt));
  const trigger = `${RESEARCH_TRIGGER_PREFIX}:${scenarioName}`;
  return task ? `${trigger} ${task}` : `${trigger} `;
}

export function deriveResearchProviderCandidates(
  entries: ReadonlyArray<ResearchProviderEntry>,
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

/** Server-side candidate projection used for provider-bound prompt expansion. */
export function deriveResearchProviderCandidatesFromProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ResearchProviderCandidate> {
  // The same strict readiness rule the delegation target resolver enforces.
  // A looser list here would let a composer accept a target the server then
  // rejects — after the draft is already cleared.
  return providers
    .filter(canStartProviderTurn)
    .map((provider) => ({
      instanceId: String(provider.instanceId),
      name: provider.displayName ?? String(provider.instanceId),
      cli: CLI_BY_DRIVER[String(provider.driver)] ?? String(provider.driver),
      models: sanitizeResearchModelSlugs(provider.models.map((model) => model.slug)),
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

const DIRECTIVE_REGEX = /!([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9._:/-]*)/g;
const PROMPT_FILE_SUFFIX_REGEX = /:([^:\s]+\.(?:md|markdown|txt))$/iu;
export const PIPELINE_DIRECTIVE_MAX_COUNT = 64;

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
    if (directives.length >= PIPELINE_DIRECTIVE_MAX_COUNT) break;
  }
  return directives;
}

/**
 * A fallback is authorized only when its directive appears on a pipeline line
 * that explicitly labels it FALLBACK. Keeping this parser narrow lets the
 * server verify model-authored tool arguments against the user-authored
 * pipeline instead of trusting the orchestrator's claim.
 */
export function parsePipelineFallbackDirectives(
  text: string,
): ReadonlyArray<ResearchModelDirective> {
  const seen = new Set<string>();
  return text.split(/\r?\n/gu).flatMap((line) => {
    if (!/\bFALLBACK\b/iu.test(line)) return [];
    return parseResearchDirectives(line).filter((directive) => {
      if (seen.has(directive.raw)) return false;
      seen.add(directive.raw);
      return true;
    });
  });
}

// ── Inline delegation ──────────────────────────────────────────────────────

/**
 * Anchored twin of DIRECTIVE_REGEX. Only a leading directive turns a message
 * into a delegation, so `see !codex:gpt-5.6-sol for context` stays prose. The
 * provider name stops at the FIRST colon; everything after it is the model,
 * because real slugs carry colons (`glm-5.2:cloud`).
 */
const INLINE_DELEGATE_TRIGGER_REGEX =
  /^\s*!([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9._:/-]*)(?=\s|$)/;

/**
 * Pipeline triggers are directive-shaped (`!research:blog`, `!dev:review`) and
 * would otherwise resolve as a provider named `research`. The pipeline parsers
 * run first; these names are refused as well so a scenario rename can never
 * reopen the ambiguity.
 */
const INLINE_DELEGATE_RESERVED_PROVIDERS: ReadonlySet<string> = new Set([
  "deep-research",
  "dev",
  "research",
]);

export interface InlineDelegateTrigger {
  /** Reuses the pipeline directive shape so resolution and error prose match. */
  readonly directive: ResearchModelDirective;
  /** The single request to send to the delegate, trigger stripped. */
  readonly task: string;
}

/**
 * Claude prompt effort prepends this transport-only marker client-side, so the
 * trigger it wraps is still the first thing the user wrote. Peeling it here
 * makes one parser authoritative: composers, timelines, and the server all see
 * the same delegation instead of each re-deriving the peel and disagreeing.
 */
const CLAUDE_EFFORT_PREFIX_REGEX = /^\s*Ultrathink:\s*\n/;

function peelInlineDelegatePrefixes(prompt: string): string {
  const effort = CLAUDE_EFFORT_PREFIX_REGEX.exec(prompt);
  return effort === null ? prompt : prompt.slice(effort[0].length);
}

/**
 * Cheap gate callers use before the full parse. A message that cannot possibly
 * open with a directive skips the work entirely, which matters on timelines
 * that re-derive per streaming tick.
 */
export function mightBeInlineDelegateTrigger(prompt: string): boolean {
  // Bounded slice: only the head can carry whitespace and the effort marker.
  const head = prompt.slice(0, 32);
  return head.includes("!") && /^\s*(?:Ultrathink:\s*\n\s*)?!/.test(head);
}

/**
 * Reads a leading `!provider:model <task>` message as one bounded delegation.
 * Tolerates leading whitespace and the Claude effort marker, because both sit
 * in front of text the user authored as a trigger. Returns null for anything
 * that is not one, including a bare trigger with no task: a delegation with
 * nothing to ask is not a delegation.
 */
export function parseInlineDelegateTrigger(prompt: string): InlineDelegateTrigger | null {
  if (!mightBeInlineDelegateTrigger(prompt)) return null;
  const text = peelInlineDelegatePrefixes(prompt);
  if (parseDevTrigger(text) !== null || parseResearchTrigger(text) !== null) return null;
  const match = INLINE_DELEGATE_TRIGGER_REGEX.exec(text);
  const provider = match?.[1];
  const model = match?.[2];
  if (!match || provider === undefined || model === undefined) return null;
  if (INLINE_DELEGATE_RESERVED_PROVIDERS.has(provider.toLowerCase())) return null;
  const task = text.slice((match.index ?? 0) + match[0].length).trim();
  if (task.length === 0) return null;
  return {
    directive: { raw: `!${provider}:${model}`, provider, model, promptFile: undefined },
    task,
  };
}

/** Drops a leading inline delegate trigger, keeping the task the user typed. */
export function stripInlineDelegateTrigger(prompt: string): string {
  return parseInlineDelegateTrigger(prompt)?.task ?? prompt;
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
 * How well a candidate answers to a directive's provider name. Lower is
 * better, and the distinction is load-bearing: an "Ollama" instance is usually
 * a `claudeAgent` driver pointed at another endpoint, so it answers to `claude`
 * on CLI while the real Claude answers to it by name. Taking the first match
 * would route `!claude:` to whichever the server streamed first.
 */
function providerMatchRank(
  candidate: ResearchProviderCandidate,
  providerNeedle: string,
): number | null {
  const name = candidate.name.toLowerCase();
  if (candidate.instanceId.toLowerCase() === providerNeedle) return 0;
  if (name === providerNeedle) return 1;
  if (candidate.cli.toLowerCase() === providerNeedle) return 2;
  if (name.startsWith(providerNeedle)) return 3;
  return null;
}

/**
 * Resolves a directive against ready providers and attached prompt files.
 * Provider matches by display name, then CLI, then name prefix — a tie at the
 * best rank is an error rather than a guess. Model matches exactly first, then
 * as a unique substring: `fable` finds `claude-fable-5`, but an ambiguous
 * fragment is an error too.
 */
export function resolveResearchDirective(
  directive: ResearchModelDirective,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  promptFiles: ReadonlyArray<ResearchPromptFile>,
): ResearchDirectiveResolution {
  const providerNeedle = directive.provider.toLowerCase();
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: providerMatchRank(candidate, providerNeedle) }))
    .filter(
      (entry): entry is { candidate: ResearchProviderCandidate; rank: number } =>
        entry.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank);
  const best = ranked.filter((entry) => entry.rank === ranked[0]?.rank);
  if (best.length > 1) {
    return {
      directive,
      ok: false,
      error: `"${directive.provider}" matches more than one provider: ${best
        .map((entry) => entry.candidate.name)
        .join(", ")}. Name one exactly.`,
    };
  }
  const provider = best[0]?.candidate;
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

/** Controller-owned snapshot of what a research turn was asked to execute. */
export function buildResearchRunManifest(
  prompt: string,
  settings: ResearchSettingsLike | undefined,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): ResearchRunManifest | null {
  const trigger = parseResearchTrigger(prompt);
  if (trigger === null) return null;
  const scenario = findResearchScenario(settings, trigger.scenarioName);
  if (scenario === null || scenario.pipelinePrompt.trim().length === 0) return null;

  const resolutions = resolveResearchDirectives(
    scenario.pipelinePrompt,
    candidates,
    scenario.promptFiles,
  );
  const steps = scenario.pipelinePrompt.split(/\r?\n/gu).flatMap((line) => {
    const match = /^\s*(\d+)[.)]\s+(.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) return [];
    const lineTargets = parseResearchDirectives(line).map((directive) => directive.raw);
    const describesDelegation = /\bdelegate|delegation|reviewer\b/iu.test(match[2]);
    return [
      {
        number: Number(match[1]),
        title: match[2].trim(),
        delegation:
          lineTargets.length > 0
            ? ("planned" as const)
            : describesDelegation
              ? ("skipped-no-target" as const)
              : ("local" as const),
        targets: lineTargets,
      },
    ];
  });

  return {
    scenario: scenario.name,
    task: trigger.task,
    pipelineHash: sha256Hex(scenario.pipelinePrompt),
    targetPolicy,
    steps,
    targets: resolutions.map((resolution) =>
      resolution.ok
        ? {
            directive: resolution.directive.raw,
            status: "resolved" as const,
            target: `${resolution.instanceId}:${resolution.model}`,
          }
        : {
            directive: resolution.directive.raw,
            status: "unresolved" as const,
            error: resolution.error,
          },
    ),
    budget: {
      maxDelegations: RESEARCH_DELEGATION_BUDGET_PER_TURN,
      maxVisitsPerStep: RESEARCH_STEP_VISIT_LIMIT,
    },
  };
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

type ResearchSettingsLike = Pick<
  ResearchSettings,
  "scenarios" | "activeScenario" | "pipelinePrompt" | "promptFiles"
>;

/**
 * The scenario list the UI and the composer work with. Pre-scenario settings
 * carried one anonymous pipeline; fold it into a `default` scenario so nothing
 * a user configured disappears. There is always at least one scenario.
 */
export function listResearchScenarios(
  settings: ResearchSettingsLike | undefined,
): ReadonlyArray<ResearchScenario> {
  const scenarios = settings?.scenarios ?? [];
  if (
    scenarios.length > 0 &&
    !(
      scenarios.length === 1 &&
      scenarios[0]?.name === DEFAULT_RESEARCH_SCENARIO_NAME &&
      scenarios[0].pipelinePrompt.trim().length === 0 &&
      scenarios[0].promptFiles.length === 0
    )
  ) {
    return scenarios;
  }
  if (!(settings?.pipelinePrompt?.trim() || settings?.promptFiles?.length)) {
    return [STARTER_RESEARCH_SCENARIO];
  }
  return [
    {
      name: DEFAULT_RESEARCH_SCENARIO_NAME,
      pipelinePrompt: settings?.pipelinePrompt ?? "",
      promptFiles: settings?.promptFiles ?? [],
    },
  ];
}

/** The scenario a trigger names, or the configured/first one for bare triggers. */
export function findResearchScenario(
  settings: ResearchSettingsLike | undefined,
  scenarioName: string | null,
): ResearchScenario | null {
  const scenarios = listResearchScenarios(settings);
  if (scenarioName !== null) {
    return scenarios.find((scenario) => scenario.name === scenarioName) ?? null;
  }
  return (
    scenarios.find((scenario) => scenario.name === settings?.activeScenario) ?? scenarios[0] ?? null
  );
}

/**
 * Compiles the orchestrator turn for a `!research[:scenario]` prompt (legacy
 * `#deep-research` still works). The scenario's pipeline is quoted verbatim
 * and framed with a strict execution protocol: step-by-step tracing through
 * the plan tool, delegation only through `research_delegate`, and explicit
 * loop budgets so a cyclic pipeline (fan out → summarize → argue → regenerate
 * → summarize again) terminates instead of orbiting. Returns the prompt
 * unchanged when it is not a research prompt, and refuses to improvise when
 * the named scenario does not exist.
 */
// Unique lines the expanded orchestrator prompt always contains. Used to
// detect an already-expanded prompt so expansion stays idempotent. Kept as
// constants so the wrapper and the guard can never drift apart.
const RESEARCH_ORCHESTRATOR_SENTINEL = "Execution protocol (non-negotiable):";
const RESEARCH_PIPELINE_SENTINEL = "PIPELINE (verbatim):";

export function expandResearchPipelinePrompt(
  prompt: string,
  settings: ResearchSettingsLike | undefined,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  const trigger = parseResearchTrigger(prompt);
  if (!trigger) return prompt;

  // Expansion is idempotent. The wrapper it emits itself begins with the
  // `!research:<scenario>` trigger, so a second pass (a resend, a paste of a
  // prior run, a handoff round-trip) would re-satisfy parseResearchTrigger and
  // wrap the whole pipeline again — the "research context twice" duplication.
  // If the text already carries the wrapper, it is already expanded; return it.
  if (
    prompt.includes(RESEARCH_ORCHESTRATOR_SENTINEL) &&
    prompt.includes(RESEARCH_PIPELINE_SENTINEL)
  ) {
    return prompt;
  }

  const { task } = trigger;
  const scenario = findResearchScenario(settings, trigger.scenarioName);
  if (!scenario) {
    const available = listResearchScenarios(settings)
      .map((entry) => `\`${entry.name}\``)
      .join(", ");
    return [
      RESEARCH_TRIGGER_PREFIX,
      "",
      `No research scenario named \`${trigger.scenarioName}\` exists. Tell the user, list the configured scenarios (${available}), and stop. Do not improvise a pipeline.`,
      "",
      "Research task:",
      task || "None provided.",
    ].join("\n");
  }

  const pipelinePrompt = scenario.pipelinePrompt.trim();
  const resolutions = resolveResearchDirectives(pipelinePrompt, candidates, scenario.promptFiles);
  const targetLines = resolutions.map((resolution) =>
    resolution.ok
      ? `- \`${resolution.directive.raw}\` → target \`${resolution.instanceId}:${resolution.model}\`${
          resolution.directive.promptFile !== undefined
            ? ` with prompt file \`${resolution.directive.promptFile}\``
            : ""
        }`
      : `- \`${resolution.directive.raw}\` → UNRESOLVED: ${resolution.error} Report this to the user in your first status instead of guessing a substitute.`,
  );
  const fileLines = scenario.promptFiles.map((file) => `- \`${file.name}\``);

  if (!pipelinePrompt) {
    return [
      RESEARCH_TRIGGER_PREFIX,
      "",
      `The research scenario \`${scenario.name}\` has no pipeline. Tell the user to define one in Settings → Research, then stop. Do not improvise a pipeline.`,
      "",
      "Research task:",
      task || "None provided.",
    ].join("\n");
  }

  return [
    `${RESEARCH_TRIGGER_PREFIX}:${scenario.name}`,
    "",
    `You are the research orchestrator for this thread, running the \`${scenario.name}\` scenario. The PIPELINE below is authoritative: follow its steps exactly, in order, including any loops it defines. Do not add, skip, merge, or reorder steps.`,
    "",
    RESEARCH_ORCHESTRATOR_SENTINEL,
    "1. TRACE — Maintain the plan tool as your step ledger: one entry per pipeline step titled `Step N: <title>`. Exactly one entry is in-progress at any time. On a revisit, append ` (visit K)` to the entry text. Begin every message with the marker `[step N | visit K]`.",
    `2. DELEGATE — A \`!provider:model[:file.md]\` directive is executed only by calling the \`research_delegate\` tool. Its \`target\` argument must be the resolved \`instanceId:model\` string from the "Delegation targets" list below, copied exactly — never the \`!\` directive itself. Pass your request as \`prompt\`, the file name as \`promptFileName\` when the directive names one, \`scenario\` as \`${scenario.name}\`, and the current \`step\`/\`visit\`. Never claim a delegation ran unless the tool returned its answer. Never delegate to yourself recursively.`,
    targetPolicy === "labeled-fallback"
      ? "3. TARGET POLICY — Labeled fallback is enabled. Pass `fallbackTargets` only for targets the PIPELINE explicitly labels as fallbacks for this step, in authored order. The tool returns `requestedTarget`, `resolvedTarget`, and `substituted`; report the resolved target and never describe a fallback as the requested model."
      : "3. TARGET POLICY — Exact targets only. Do not pass or invent fallbacks. If a target is unavailable, report that step as failed.",
    `4. LOOP GUARD — A step may run at most ${RESEARCH_STEP_VISIT_LIMIT} visits and the whole turn has a hard budget of ${RESEARCH_DELEGATION_BUDGET_PER_TURN} delegations, enforced by the server. When a guard trips, stop looping, synthesize from what you have, and state plainly which loop was cut and why.`,
    "5. HONESTY — Preserve links, file paths, commands, disagreements, and uncertainty when summarizing delegate answers. A delegate that failed or timed out is reported as failed, not paraphrased into a result. When delegates disagree, record both positions as competing claims; never let a later answer silently overwrite an earlier one.",
    "6. RUN STATE — End the run with a `RUN STATE` section listing every step: requested target, actual resolved target, whether a labeled fallback was used, visits, and outcome (`SUCCESS`, or the failure the tool reported: refusal, timeout, error, empty). The synthesis must state which conclusions rest on failed or missing steps. A run report that hides a failure is a failed run.",
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
    RESEARCH_PIPELINE_SENTINEL,
    pipelinePrompt,
    "",
    "Research task:",
    task || "Ask the user for the research question before starting the pipeline.",
  ].join("\n");
}
