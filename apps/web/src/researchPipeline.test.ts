import { describe, expect, it } from "vite-plus/test";

import {
  deriveDirectiveSuggestions,
  expandResearchPipelinePrompt,
  findResearchScenario,
  isDeepResearchPrompt,
  parseResearchDirectives,
  parseResearchTrigger,
  resolveResearchDirective,
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
      orchestratorSelection: null,
      pipelinePrompt:
        "Step 1: plan.\nStep 2: fan out to !claude:fable:OPTIONAL_prompt.md and !codex:terra.",
      promptFiles: FILES,
    },
    {
      name: "audit",
      orchestratorSelection: null,
      pipelinePrompt: "Step 1: audit.",
      promptFiles: [],
    },
  ],
  activeScenario: "blog",
  orchestratorSelection: null,
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

describe("findResearchScenario", () => {
  it("finds by name, falls back to active, and migrates legacy fields", () => {
    expect(findResearchScenario(RESEARCH_SETTINGS, "audit")?.name).toBe("audit");
    expect(findResearchScenario(RESEARCH_SETTINGS, null)?.name).toBe("blog");
    expect(findResearchScenario(RESEARCH_SETTINGS, "missing")).toBeNull();
    const legacy = {
      scenarios: [],
      activeScenario: "",
      orchestratorSelection: null,
      pipelinePrompt: "Step 1: legacy.",
      promptFiles: FILES,
    };
    const migrated = findResearchScenario(legacy, null);
    expect(migrated?.name).toBe("default");
    expect(migrated?.pipelinePrompt).toBe("Step 1: legacy.");
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
      "#deep-research go",
      { ...pipeline, scenarios: [], pipelinePrompt: "" },
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
