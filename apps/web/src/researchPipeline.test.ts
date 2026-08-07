import { describe, expect, it } from "vite-plus/test";

import {
  expandResearchPipelinePrompt,
  isDeepResearchPrompt,
  parseResearchDirectives,
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

describe("expandResearchPipelinePrompt", () => {
  const pipeline = {
    pipelinePrompt:
      "Step 1: plan.\nStep 2: fan out to !claude:fable:OPTIONAL_prompt.md and !codex:terra.",
    promptFiles: FILES,
  };

  it("leaves non-research prompts untouched", () => {
    expect(expandResearchPipelinePrompt("hello", pipeline, CANDIDATES)).toBe("hello");
  });

  it("quotes the pipeline verbatim with protocol, targets, and loop budgets", () => {
    const expanded = expandResearchPipelinePrompt("#deep-research compare X", pipeline, CANDIDATES);
    expect(expanded).toContain("PIPELINE (verbatim):");
    expect(expanded).toContain(pipeline.pipelinePrompt);
    expect(expanded).toContain("claudeAgent:claude-fable-5");
    expect(expanded).toContain("research_delegate");
    expect(expanded).toContain("[step N | visit K]");
    expect(expanded).toContain("compare X");
  });

  it("surfaces unresolved directives instead of dropping them", () => {
    const expanded = expandResearchPipelinePrompt(
      "#deep-research go",
      { ...pipeline, pipelinePrompt: "Step 1: !gemini:pro decides." },
      CANDIDATES,
    );
    expect(expanded).toContain("UNRESOLVED");
  });

  it("refuses to improvise when no pipeline is configured", () => {
    const expanded = expandResearchPipelinePrompt(
      "#deep-research go",
      { pipelinePrompt: "", promptFiles: [] },
      CANDIDATES,
    );
    expect(expanded).toContain("Settings → Research");
    expect(expanded).toContain("Do not improvise");
  });

  it("still detects the research tag case-insensitively", () => {
    expect(isDeepResearchPrompt("  #DEEP-research topic")).toBe(true);
  });
});
