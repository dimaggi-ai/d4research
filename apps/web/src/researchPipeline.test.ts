import { describe, expect, it } from "vite-plus/test";

import {
  applyResearchTrigger,
  buildResearchRunManifest,
  deriveDirectiveSuggestions,
  deriveResearchProviderCandidatesFromProviders,
  expandResearchPipelinePrompt,
  findResearchScenario,
  listResearchScenarios,
  isDeepResearchPrompt,
  mightBeInlineDelegateTrigger,
  parseInlineDelegateTrigger,
  parsePipelineFallbackDirectives,
  parseResearchDirectives,
  PIPELINE_DIRECTIVE_MAX_COUNT,
  parseResearchTrigger,
  stripInlineDelegateTrigger,
  stripResearchTrigger,
  resolveResearchDirective,
  sanitizeResearchModelSlugs,
  type ResearchProviderCandidate,
} from "./researchPipeline";

const CANDIDATES: ReadonlyArray<ResearchProviderCandidate> = [
  {
    instanceId: "claudeAgent",
    name: "Claude",
    cli: "claude",
    models: ["claude-fable-5", "claude-opus-5", "glm-5.2:cloud"],
  },
  { instanceId: "codex", name: "Codex", cli: "codex", models: ["gpt-5.6-terra", "gpt-5.6-sol"] },
];

const FILES = [{ name: "OPTIONAL_prompt.md", content: "be thorough" }];

describe("research model catalog", () => {
  it("keeps every valid discovered model instead of silently truncating large CLIs", () => {
    const models = [
      ...Array.from({ length: 80 }, (_, index) => `model-${index}`),
      "invalid model",
      "\u2800\u2801 spinner",
    ];
    const sanitized = sanitizeResearchModelSlugs(models);
    expect(sanitized).toHaveLength(80);
    expect(sanitized.at(-1)).toBe("model-79");
  });
});

describe("parseResearchDirectives", () => {
  it("parses provider, model, and optional prompt file", () => {
    expect(parseResearchDirectives("send !claude:fable:OPTIONAL_prompt.md now")).toEqual([
      {
        raw: "!claude:fable:OPTIONAL_prompt.md",
        provider: "claude",
        model: "fable",
        promptFile: "OPTIONAL_prompt.md",
      },
    ]);
  });

  it("keeps colons that belong to the model slug", () => {
    expect(parseResearchDirectives("ask !claude:glm-5.2:cloud")).toEqual([
      {
        raw: "!claude:glm-5.2:cloud",
        provider: "claude",
        model: "glm-5.2:cloud",
        promptFile: undefined,
      },
    ]);
  });

  it("splits a file suffix off a colon-bearing model", () => {
    expect(parseResearchDirectives("ask !claude:glm-5.2:cloud:notes.md")).toEqual([
      {
        raw: "!claude:glm-5.2:cloud:notes.md",
        provider: "claude",
        model: "glm-5.2:cloud",
        promptFile: "notes.md",
      },
    ]);
  });

  it("dedupes repeated directives and ignores plain text", () => {
    const found = parseResearchDirectives("!codex:terra then !codex:terra again, no bang here");
    expect(found).toHaveLength(1);
  });

  it("strips sentence punctuation trailing a directive — found by live QA", () => {
    expect(parseResearchDirectives("Delegate the question to !claude:fable.")).toEqual([
      { raw: "!claude:fable", provider: "claude", model: "fable", promptFile: undefined },
    ]);
    expect(parseResearchDirectives("ask !codex:terra, then !claude:fable; summarize")).toEqual([
      { raw: "!codex:terra", provider: "codex", model: "terra", promptFile: undefined },
      { raw: "!claude:fable", provider: "claude", model: "fable", promptFile: undefined },
    ]);
  });

  it("rejects lookalikes and malformed prompt-file suffixes without corrupting neighbors", () => {
    expect(
      parseResearchDirectives(
        "! missing, ！codex:terra, !-bad:model, !codex:, !codex:terra:file.pdf, then !codex:sol",
      ),
    ).toEqual([
      {
        raw: "!codex:terra:file.pdf",
        provider: "codex",
        model: "terra:file.pdf",
        promptFile: undefined,
      },
      { raw: "!codex:sol", provider: "codex", model: "sol", promptFile: undefined },
    ]);
  });

  it("bounds adversarial directive floods while preserving deterministic first-seen order", () => {
    const prompt = Array.from(
      { length: PIPELINE_DIRECTIVE_MAX_COUNT * 20 },
      (_, index) => `step ${index}: !codex:model-${index}`,
    ).join("\n");
    const found = parseResearchDirectives(prompt);
    expect(found).toHaveLength(PIPELINE_DIRECTIVE_MAX_COUNT);
    expect(found[0]?.raw).toBe("!codex:model-0");
    expect(found.at(-1)?.raw).toBe(`!codex:model-${PIPELINE_DIRECTIVE_MAX_COUNT - 1}`);
  });

  it("deduplicates a large repeated prompt before applying the cap", () => {
    const prompt = "!codex:terra ".repeat(10_000);
    expect(parseResearchDirectives(prompt)).toEqual([
      { raw: "!codex:terra", provider: "codex", model: "terra", promptFile: undefined },
    ]);
  });

  it("treats only explicitly labeled lines as authored fallbacks", () => {
    expect(
      parsePipelineFallbackDirectives(
        "PRIMARY: !claude:opus\nFALLBACK directive: !codex:sol\nreview !codex:terra",
      ).map((directive) => directive.raw),
    ).toEqual(["!codex:sol"]);
  });
});

describe("resolveResearchDirective", () => {
  const parse = (text: string) => parseResearchDirectives(text)[0]!;

  it("resolves a fuzzy model against a named provider", () => {
    expect(resolveResearchDirective(parse("!claude:fable"), CANDIDATES, FILES)).toMatchObject({
      ok: true,
      instanceId: "claudeAgent",
      model: "claude-fable-5",
    });
  });

  it("rejects an ambiguous model fragment instead of guessing", () => {
    const resolution = resolveResearchDirective(parse("!claude:claude"), CANDIDATES, FILES);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain("ambiguous");
  });

  it("rejects an unknown provider with the ready list", () => {
    const resolution = resolveResearchDirective(parse("!gemini:pro"), CANDIDATES, FILES);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain("Claude");
  });

  it("rejects a directive naming an unattached prompt file", () => {
    const resolution = resolveResearchDirective(
      parse("!codex:terra:missing.md"),
      CANDIDATES,
      FILES,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain("missing.md");
  });
});

describe("deriveDirectiveSuggestions", () => {
  it("suggests providers right after the bang", () => {
    const suggestions = deriveDirectiveSuggestions("Step 2: fan out to !", CANDIDATES, FILES);
    expect(suggestions.map((entry) => entry.insert)).toEqual(["!claude:", "!codex:"]);
    expect(suggestions[0]?.tokenStart).toBe("Step 2: fan out to ".length);
  });

  it("narrows providers by prefix", () => {
    expect(deriveDirectiveSuggestions("send to !co", CANDIDATES, FILES)).toMatchObject([
      { insert: "!codex:" },
    ]);
  });

  it("suggests the provider's models after the colon, filtered by fragment", () => {
    expect(
      deriveDirectiveSuggestions("!claude:fab", CANDIDATES, FILES).map((entry) => entry.insert),
    ).toEqual(["!claude:claude-fable-5"]);
    expect(deriveDirectiveSuggestions("!claude:", CANDIDATES, FILES)).toHaveLength(3);
  });

  it("offers attached prompt files after a complete model and colon", () => {
    expect(
      deriveDirectiveSuggestions("!claude:claude-fable-5:", CANDIDATES, FILES).map(
        (entry) => entry.insert,
      ),
    ).toEqual(["!claude:claude-fable-5:OPTIONAL_prompt.md"]);
  });

  it("stays quiet outside a directive token", () => {
    expect(deriveDirectiveSuggestions("plain prose, no token", CANDIDATES, FILES)).toEqual([]);
    expect(deriveDirectiveSuggestions("ends with space ! ", CANDIDATES, FILES)).toEqual([]);
  });
});

const RESEARCH_SETTINGS = {
  scenarios: [
    {
      name: "blog",
      pipelinePrompt:
        "Step 1: plan.\nStep 2: fan out to !claude:fable:OPTIONAL_prompt.md and !codex:terra.",
      promptFiles: FILES,
    },
    {
      name: "audit",
      pipelinePrompt: "Step 1: audit.",
      promptFiles: [],
    },
  ],
  activeScenario: "blog",
  pipelinePrompt: "",
  promptFiles: [],
};

describe("parseResearchTrigger", () => {
  it("parses !research:name, bare !research, and legacy #deep-research", () => {
    expect(parseResearchTrigger("!research:blog write about X")).toEqual({
      scenarioName: "blog",
      task: "write about X",
    });
    expect(parseResearchTrigger("!research just do it")).toEqual({
      scenarioName: null,
      task: "just do it",
    });
    expect(parseResearchTrigger("  #deep-research topic")).toEqual({
      scenarioName: null,
      task: "topic",
    });
    expect(parseResearchTrigger("!researcher is a word")).toBeNull();
    expect(parseResearchTrigger("plain prompt")).toBeNull();
  });
});

describe("stripResearchTrigger", () => {
  // Triggers vary in length, so the composer cannot slice a fixed tag off.
  it("removes triggers of any length and leaves untriggered prompts alone", () => {
    expect(stripResearchTrigger("!research:blog write about X")).toBe("write about X");
    expect(stripResearchTrigger("!research just do it")).toBe("just do it");
    expect(stripResearchTrigger("  #deep-research topic")).toBe("topic");
    expect(stripResearchTrigger("!research:blog")).toBe("");
    expect(stripResearchTrigger("plain prompt")).toBe("plain prompt");
  });
});

describe("pipeline mode switching", () => {
  it("replaces a dev trigger instead of nesting it inside research", () => {
    expect(applyResearchTrigger("!dev:fix repair auth", "blog")).toBe("!research:blog repair auth");
  });
});

describe("findResearchScenario", () => {
  it("finds by name, falls back to active, and migrates legacy fields", () => {
    expect(findResearchScenario(RESEARCH_SETTINGS, "audit")?.name).toBe("audit");
    expect(findResearchScenario(RESEARCH_SETTINGS, null)?.name).toBe("blog");
    expect(findResearchScenario(RESEARCH_SETTINGS, "missing")).toBeNull();
    const legacy = {
      scenarios: [],
      activeScenario: "",
      pipelinePrompt: "Step 1: legacy.",
      promptFiles: FILES,
    };
    const migrated = findResearchScenario(legacy, null);
    expect(migrated?.name).toBe("default");
    expect(migrated?.pipelinePrompt).toBe("Step 1: legacy.");
  });

  it("gives an empty fresh or legacy-default configuration the bounded starter", () => {
    const fresh = listResearchScenarios(undefined);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.name).toBe("starter");
    expect(fresh[0]?.pipelinePrompt).toContain("Stop after one evidence pass");

    const historicalEmpty = listResearchScenarios({
      scenarios: [{ name: "default", pipelinePrompt: "", promptFiles: [] }],
      activeScenario: "default",
      pipelinePrompt: "",
      promptFiles: [],
    });
    expect(historicalEmpty[0]?.name).toBe("starter");
  });
});

describe("expandResearchPipelinePrompt", () => {
  const pipeline = RESEARCH_SETTINGS;

  it("leaves non-research prompts untouched", () => {
    expect(expandResearchPipelinePrompt("hello", pipeline, CANDIDATES)).toBe("hello");
  });

  it("quotes the pipeline verbatim with protocol, targets, and loop budgets", () => {
    const expanded = expandResearchPipelinePrompt("!research:blog compare X", pipeline, CANDIDATES);
    expect(expanded).toContain("PIPELINE (verbatim):");
    expect(expanded).toContain(pipeline.scenarios[0]!.pipelinePrompt);
    expect(expanded).toContain("`blog` scenario");
    expect(expanded).toContain("claudeAgent:claude-fable-5");
    expect(expanded).toContain("research_delegate");
    expect(expanded).toContain("[step N | visit K]");
    expect(expanded).toContain("compare X");
  });

  it("is idempotent: re-expanding an expanded prompt does not duplicate the wrapper", () => {
    const once = expandResearchPipelinePrompt("!research:blog compare X", pipeline, CANDIDATES);
    const twice = expandResearchPipelinePrompt(once, pipeline, CANDIDATES);
    expect(twice).toBe(once);
    // The wrapper and the pipeline each appear exactly once, not nested.
    expect(twice.split("PIPELINE (verbatim):").length - 1).toBe(1);
    expect(twice.split("Execution protocol (non-negotiable):").length - 1).toBe(1);
  });

  it("requires an explicit run-state report in the protocol", () => {
    const expanded = expandResearchPipelinePrompt("!research:blog go", pipeline, CANDIDATES);
    // The orchestrator must end with a per-step outcome ledger and admit
    // which conclusions rest on failed steps — never a smoothed-over summary.
    expect(expanded).toContain("RUN STATE");
    expect(expanded).toContain("A run report that hides a failure is a failed run.");
    expect(expanded).toContain("competing claims");
    expect(expanded).toContain("requested target, actual resolved target");
    expect(expanded).not.toContain("equivalent model");
  });

  it("shares the exact-target policy with development pipelines", () => {
    const expanded = expandResearchPipelinePrompt(
      "!research:blog go",
      pipeline,
      CANDIDATES,
      "exact",
    );
    expect(expanded).toContain("Exact targets only");
    expect(expanded).toContain("Do not pass or invent fallbacks");
  });

  it("surfaces unresolved directives instead of dropping them", () => {
    const expanded = expandResearchPipelinePrompt(
      "!research:blog go",
      {
        ...pipeline,
        scenarios: [{ ...pipeline.scenarios[0]!, pipelinePrompt: "Step 1: !gemini:pro decides." }],
      },
      CANDIDATES,
    );
    expect(expanded).toContain("UNRESOLVED");
  });

  it("refuses to improvise when no pipeline is configured", () => {
    const expanded = expandResearchPipelinePrompt(
      "!research:empty go",
      {
        ...pipeline,
        scenarios: [{ name: "empty", pipelinePrompt: "", promptFiles: [] }],
        activeScenario: "empty",
      },
      CANDIDATES,
    );
    expect(expanded).toContain("Settings → Research");
    expect(expanded).toContain("Do not improvise");
  });

  it("refuses to improvise for an unknown scenario and lists the real ones", () => {
    const expanded = expandResearchPipelinePrompt("!research:nope go", pipeline, CANDIDATES);
    expect(expanded).toContain("No research scenario named `nope`");
    expect(expanded).toContain("`blog`");
    expect(expanded).toContain("`audit`");
    expect(expanded).toContain("Do not improvise");
  });

  it("still detects the research tag case-insensitively", () => {
    expect(isDeepResearchPrompt("  #DEEP-research topic")).toBe(true);
  });
});

describe("deriveResearchProviderCandidatesFromProviders", () => {
  const readyProvider = {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-08T00:00:00.000Z",
    availability: "available",
    models: [{ slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } as unknown as Parameters<typeof deriveResearchProviderCandidatesFromProviders>[0][number];

  it("offers a target the server would accept", () => {
    expect(deriveResearchProviderCandidatesFromProviders([readyProvider])).toHaveLength(1);
  });

  it("hides a provider the server's readiness rule would reject", () => {
    // Unauthenticated and explicitly not-startable providers both fail
    // canStartProviderTurn on the server; offering them would let a composer
    // accept a target the server rejects after the draft is cleared.
    const unauthenticated = { ...readyProvider, auth: { status: "unauthenticated" } } as never;
    const blocked = { ...readyProvider, readiness: { canStart: false } } as never;
    expect(deriveResearchProviderCandidatesFromProviders([unauthenticated])).toEqual([]);
    expect(deriveResearchProviderCandidatesFromProviders([blocked])).toEqual([]);
  });
});

describe("parseInlineDelegateTrigger", () => {
  it("reads a leading provider:model mention as one bounded delegation", () => {
    expect(parseInlineDelegateTrigger("!codex:gpt-5.6-sol explain this stack trace")).toEqual({
      directive: {
        raw: "!codex:gpt-5.6-sol",
        provider: "codex",
        model: "gpt-5.6-sol",
        promptFile: undefined,
      },
      task: "explain this stack trace",
    });
  });

  it("splits provider at the first colon so colon-bearing slugs survive", () => {
    expect(parseInlineDelegateTrigger("!claude:glm-5.2:cloud summarize")?.directive).toEqual({
      raw: "!claude:glm-5.2:cloud",
      provider: "claude",
      model: "glm-5.2:cloud",
      promptFile: undefined,
    });
  });

  it("never claims a pipeline trigger — !dev and !research win", () => {
    expect(parseInlineDelegateTrigger("!dev:review fix the bug")).toBeNull();
    expect(parseInlineDelegateTrigger("!research:blog compare X")).toBeNull();
    expect(parseInlineDelegateTrigger("#deep-research:blog compare X")).toBeNull();
  });

  it("refuses reserved provider names even without a pipeline scenario", () => {
    expect(parseInlineDelegateTrigger("!research:something ask")).toBeNull();
    expect(parseInlineDelegateTrigger("!DEV:something ask")).toBeNull();
    expect(parseInlineDelegateTrigger("!deep-research:x ask")).toBeNull();
  });

  it("is anchored — a mid-text mention stays prose", () => {
    expect(parseInlineDelegateTrigger("compare against !codex:gpt-5.6-sol later")).toBeNull();
    expect(parseInlineDelegateTrigger("ask\n!codex:gpt-5.6-sol why")).toBeNull();
  });

  it("rejects a trigger with no task", () => {
    expect(parseInlineDelegateTrigger("!codex:gpt-5.6-sol")).toBeNull();
    expect(parseInlineDelegateTrigger("  !codex:gpt-5.6-sol   ")).toBeNull();
  });

  it("requires the trigger to end on a boundary", () => {
    expect(parseInlineDelegateTrigger("!codex:gpt-5.6-sol,explain")).toBeNull();
  });

  it("sees through the Claude effort marker, so every surface parses alike", () => {
    // The marker is transport-only and prepended client-side; the trigger it
    // wraps is still the first thing the user wrote.
    const withEffort = "Ultrathink:\n!codex:gpt-5.6-sol explain this stack trace";
    expect(parseInlineDelegateTrigger(withEffort)).toEqual(
      parseInlineDelegateTrigger("!codex:gpt-5.6-sol explain this stack trace"),
    );
    expect(mightBeInlineDelegateTrigger(withEffort)).toBe(true);
  });

  it("sees through leading whitespace", () => {
    expect(parseInlineDelegateTrigger("   !codex:gpt-5.6-sol explain")).toEqual(
      parseInlineDelegateTrigger("!codex:gpt-5.6-sol explain"),
    );
    expect(mightBeInlineDelegateTrigger("   !codex:gpt-5.6-sol explain")).toBe(true);
  });

  it("still refuses a pipeline trigger behind the effort marker", () => {
    expect(parseInlineDelegateTrigger("Ultrathink:\n!dev:review fix it")).toBeNull();
    expect(parseInlineDelegateTrigger("Ultrathink:\n!research:blog compare")).toBeNull();
  });

  it("gates cheaply without rejecting anything the parser accepts", () => {
    expect(mightBeInlineDelegateTrigger("plain prompt")).toBe(false);
    expect(mightBeInlineDelegateTrigger("compare with !codex:sol")).toBe(false);
    // A long effort-marker-free head with no bang cannot be a trigger.
    expect(mightBeInlineDelegateTrigger("x".repeat(200))).toBe(false);
  });

  it("keeps the task recoverable for the composer", () => {
    expect(stripInlineDelegateTrigger("!codex:gpt-5.6-sol explain this")).toBe("explain this");
    expect(stripInlineDelegateTrigger("plain prompt")).toBe("plain prompt");
  });

  it("resolves through the same directive resolver as pipelines", () => {
    const trigger = parseInlineDelegateTrigger("!claude:fable what changed?");
    expect(trigger).not.toBeNull();
    expect(resolveResearchDirective(trigger!.directive, CANDIDATES, [])).toMatchObject({
      ok: true,
      instanceId: "claudeAgent",
      model: "claude-fable-5",
    });
  });
});

describe("research run manifest", () => {
  it("freezes the scenario, budget, targets, and intentional skips before execution", () => {
    const manifest = buildResearchRunManifest(
      "!research:blog compare X",
      RESEARCH_SETTINGS,
      CANDIDATES,
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.scenario).toBe("blog");
    expect(manifest?.task).toBe("compare X");
    expect(manifest?.pipelineHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest?.targetPolicy).toBe("labeled-fallback");
    expect(manifest?.budget).toEqual({ maxDelegations: 24, maxVisitsPerStep: 3 });
    expect(manifest?.targets).toContainEqual({
      directive: "!claude:fable:OPTIONAL_prompt.md",
      status: "resolved",
      target: "claudeAgent:claude-fable-5",
    });
  });

  it("marks a delegate step without an explicit target as skipped", () => {
    const manifest = buildResearchRunManifest("!research:starter inspect", undefined, CANDIDATES);
    expect(manifest?.steps.find((step) => step.number === 4)?.delegation).toBe("skipped-no-target");
  });
});
