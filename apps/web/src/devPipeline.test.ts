import { describe, expect, it } from "vite-plus/test";

import {
  activeDevScenarioName,
  applyDevTrigger,
  buildDefaultDevPipelinePrompt,
  deriveDevProviderCandidates,
  devPipelineControlKind,
  expandDevPipelinePrompt,
  findDevScenario,
  isDevPipelinePrompt,
  listDevScenarios,
  parseDevTrigger,
  parseDevPipelineOptionEvent,
  providerDriverSupportsPipelineOrchestration,
  stripDevTrigger,
  shouldExitPlanForDevPipelineSelection,
  type DevProviderCandidate,
} from "./devPipeline";
import { stripResearchTrigger } from "./researchPipeline";

const CANDIDATES: ReadonlyArray<DevProviderCandidate> = [
  {
    instanceId: "claudeAgent",
    name: "Claude",
    cli: "claude",
    models: ["claude-fable-5", "claude-opus-5"],
  },
  { instanceId: "codex", name: "Codex", cli: "codex", models: ["gpt-5.6-terra"] },
  {
    instanceId: "ollama",
    name: "Ollama",
    cli: "claude",
    models: ["kimi-k2.7-code:cloud", "nemotron-3-super:cloud", "glm-5.2:cloud"],
  },
  // Junie's real catalog, as captured from `junie --acp=true` session/new.
  // Note `gemini-3.1-pro-preview`, not `gemini-3.1-pro`: ids the CLI rejects
  // look identical in a prompt and only fail once a delegation is already open.
  {
    instanceId: "junie",
    name: "Junie",
    cli: "junie",
    models: [
      "gemini-3-flash-preview",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "gemini-3.1-pro-preview",
      "gemini-3.6-flash",
      "gpt-5.3-codex",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "grok-4.5",
      "custom:t3-local-ollama",
    ],
  },
];

const settings = {
  scenarios: [
    { name: "fix", pipelinePrompt: "Step 1: !claude:fable plans.", promptFiles: [] },
    { name: "audit", pipelinePrompt: "Step 1: audit.", promptFiles: [] },
  ],
  activeScenario: "fix",
};

describe("parseDevTrigger", () => {
  it("parses a named pipeline and a bare trigger", () => {
    expect(parseDevTrigger("!dev:fix the login bug")).toEqual({
      scenarioName: "fix",
      task: "the login bug",
    });
    expect(parseDevTrigger("!dev make it faster")).toEqual({
      scenarioName: null,
      task: "make it faster",
    });
  });

  it("does not fire on a word that merely starts with dev", () => {
    // "!devops" must stay ordinary prompt text.
    expect(parseDevTrigger("!devops pipeline")).toBeNull();
    expect(parseDevTrigger("deploy to dev")).toBeNull();
  });

  it("strips a trigger of any length, keeping the task", () => {
    expect(stripDevTrigger("!dev:fix the login bug")).toBe("the login bug");
    expect(stripDevTrigger("!dev  make it faster")).toBe("make it faster");
    expect(stripDevTrigger("plain prompt")).toBe("plain prompt");
  });

  it("recognizes a dev prompt", () => {
    expect(isDevPipelinePrompt("!dev:fix x")).toBe(true);
    expect(isDevPipelinePrompt("!research:default x")).toBe(false);
  });
});

describe("the composer picker's trigger handling", () => {
  it("parses mobile pipeline option events without consuming unrelated menu actions", () => {
    expect(parseDevPipelineOptionEvent("options:dev-pipeline:review")).toEqual({
      scenarioName: "review",
    });
    expect(parseDevPipelineOptionEvent("options:dev-pipeline:off")).toEqual({
      scenarioName: null,
    });
    expect(parseDevPipelineOptionEvent("options:interaction:plan")).toBeNull();
    expect(parseDevPipelineOptionEvent("options:dev-pipeline:../escape")).toBeNull();
    expect(parseDevPipelineOptionEvent("options:dev-pipeline:")).toBeNull();
  });

  it("keeps the pipeline picker on providers without native Plan support", () => {
    expect(devPipelineControlKind(false, "default")).toBe("pipeline-picker");
    expect(devPipelineControlKind(false, "plan")).toBe("pipeline-picker");
    expect(devPipelineControlKind(true, "plan")).toBe("plan-exit");
  });

  it("exits native Plan only when arming a real pipeline", () => {
    expect(shouldExitPlanForDevPipelineSelection("plan", "review")).toBe(true);
    expect(shouldExitPlanForDevPipelineSelection("plan", null)).toBe(false);
    expect(shouldExitPlanForDevPipelineSelection("default", "review")).toBe(false);
  });

  it("reports which pipeline a prompt arms, treating bare !dev as the default", () => {
    expect(activeDevScenarioName("!dev:fix the login bug")).toBe("fix");
    expect(activeDevScenarioName("!dev do the thing")).toBe("default");
    expect(activeDevScenarioName("just a question")).toBeNull();
  });

  it("swaps pipelines in place without eating the task", () => {
    expect(applyDevTrigger("!dev:fix the login bug", "audit")).toBe("!dev:audit the login bug");
    expect(applyDevTrigger("the login bug", "fix")).toBe("!dev:fix the login bug");
  });

  it("disarms back to the bare task, which is the way out of the mode", () => {
    expect(applyDevTrigger("!dev:fix the login bug", null)).toBe("the login bug");
    expect(applyDevTrigger("the login bug", null)).toBe("the login bug");
  });

  it("leaves a trailing space to type into when the prompt is empty", () => {
    expect(applyDevTrigger("", "fix")).toBe("!dev:fix ");
    expect(applyDevTrigger("!dev:fix ", null)).toBe("");
  });

  it("round-trips, so arming and disarming cannot corrupt the prompt", () => {
    const task = "fix the !important flag parsing";
    expect(applyDevTrigger(applyDevTrigger(task, "fix"), null)).toBe(task);
    expect(activeDevScenarioName(applyDevTrigger(task, "audit"))).toBe("audit");
  });

  it("replaces a research trigger instead of nesting it inside dev", () => {
    expect(applyDevTrigger(stripResearchTrigger("!research:blog repair auth"), "fix")).toBe(
      "!dev:fix repair auth",
    );
  });
});

describe("dev scenarios", () => {
  it("falls back to a usable default pipeline when none are configured", () => {
    const [scenario] = listDevScenarios(undefined, CANDIDATES);
    expect(scenario).toMatchObject({ name: "default", promptFiles: [] });

    const expanded = expandDevPipelinePrompt(
      "!dev:default repair login",
      { scenarios: [scenario!], activeScenario: "default" },
      CANDIDATES,
    );
    expect(expanded).not.toContain("UNRESOLVED");
    expect(expanded.match(/research_delegate/g)).toHaveLength(1);
    expect(expanded).toContain("Task:\nrepair login");
  });

  it("gives every default step a fallback directive", () => {
    // A model being down mid-run is normal; every step must have somewhere to go.
    const steps = buildDefaultDevPipelinePrompt(CANDIDATES)
      .split(/^STEP /m)
      .slice(1);
    expect(steps).toHaveLength(4);
    for (const step of steps) {
      expect(step).toContain("FALLBACK directive:");
    }
  });

  it("finds by name, falls back to the active one, and reports unknown", () => {
    expect(findDevScenario(settings, "audit")?.name).toBe("audit");
    expect(findDevScenario(settings, null)?.name).toBe("fix");
    expect(findDevScenario(settings, "missing")).toBeNull();
  });
});

describe("expandDevPipelinePrompt", () => {
  it("frames the pipeline with protocol, targets, and the task", () => {
    const expanded = expandDevPipelinePrompt("!dev:fix the login bug", settings, CANDIDATES);
    expect(expanded).toContain("Dev pipeline protocol (non-negotiable):");
    expect(expanded).toContain("PIPELINE (verbatim):");
    expect(expanded).toContain("Step 1: !claude:fable plans.");
    expect(expanded).toContain("the login bug");
    // The engine is shared with research: delegation goes through the tool.
    expect(expanded).toContain("research_delegate");
  });

  it("resolves a fuzzy directive into a concrete target", () => {
    const expanded = expandDevPipelinePrompt("!dev:fix go", settings, CANDIDATES);
    expect(expanded).toContain("claudeAgent:claude-fable-5");
  });

  it("keeps the run in this thread and makes the human the one who edits", () => {
    const expanded = expandDevPipelinePrompt("!dev:fix go", settings, CANDIDATES);
    expect(expanded).toContain("in this thread");
    expect(expanded).toContain("the delegates advise, you edit");
  });

  it("demands honest failure reporting and a run state", () => {
    const expanded = expandDevPipelinePrompt("!dev:fix go", settings, CANDIDATES);
    expect(expanded).toContain("RUN STATE");
    expect(expanded).toContain("reported as FAILED");
    // The exact failure that burned real runs: an intent-only reply.
    expect(expanded).toContain("intent only");
  });

  it("is idempotent, so a resend never wraps the pipeline twice", () => {
    const once = expandDevPipelinePrompt("!dev:fix go", settings, CANDIDATES);
    const twice = expandDevPipelinePrompt(once, settings, CANDIDATES);
    expect(twice).toBe(once);
    expect(twice.split("PIPELINE (verbatim):").length - 1).toBe(1);
  });

  it("surfaces an unresolved directive instead of guessing a substitute", () => {
    const expanded = expandDevPipelinePrompt(
      "!dev:fix go",
      {
        ...settings,
        scenarios: [{ name: "fix", pipelinePrompt: "Step 1: !gemini:pro plans.", promptFiles: [] }],
      },
      CANDIDATES,
    );
    expect(expanded).toContain("UNRESOLVED");
    expect(expanded).toContain("FALLBACK");
  });

  it("refuses to improvise when the named pipeline does not exist", () => {
    const expanded = expandDevPipelinePrompt("!dev:nope go", settings, CANDIDATES);
    expect(expanded).toContain("No dev pipeline named");
    expect(expanded).toContain("Do not improvise");
  });

  it("leaves a non-dev prompt untouched", () => {
    expect(expandDevPipelinePrompt("just a question", settings, CANDIDATES)).toBe(
      "just a question",
    );
  });
});

describe("default pipeline targets", () => {
  it("only names providers that exist in this environment", () => {
    // grok and cursor are disabled here; a default that referenced them would
    // resolve to UNRESOLVED on every run.
    const prompt = buildDefaultDevPipelinePrompt(CANDIDATES);
    expect(prompt).not.toContain("!grok:");
    expect(prompt).not.toContain("!cursor:");
    // Junie is a real target: the driver is built in and it serves a hosted
    // catalog, so it carries the review family nothing else in the stack has.
    expect(prompt).toContain("!junie:");
  });

  it("keeps the reviewer in a different family from the builder", () => {
    // Same-family review is a rubber stamp; this is the whole point of step 3.
    const prompt = buildDefaultDevPipelinePrompt(CANDIDATES);
    const build = /STEP 2 — BUILD[\s\S]*?Directive: (\S+)/.exec(prompt);
    const review = /STEP 3 — REVIEW[\s\S]*?Directive: (\S+)/.exec(prompt);
    expect(build).not.toBeNull();
    expect(review).not.toBeNull();
    expect(build![1]).toBe("!junie:grok-4.5");
    expect(review![1]).toBe("!codex:gpt-5.6-terra");
    expect(build![1]!.split(":")[0]).not.toBe(review![1]!.split(":")[0]);
  });

  it("requires the verification command to actually be run", () => {
    expect(buildDefaultDevPipelinePrompt(CANDIDATES)).toContain("paste real output");
  });

  it("resolves every directive it names against this environment", () => {
    // The failure this pins: a default that ships a target no provider serves
    // degrades to UNRESOLVED on every run, silently, from the first delegation.
    const expanded = expandDevPipelinePrompt(
      "!dev:default go",
      {
        scenarios: [
          {
            name: "default",
            pipelinePrompt: buildDefaultDevPipelinePrompt(CANDIDATES),
            promptFiles: [],
          },
        ],
        activeScenario: "default",
      },
      CANDIDATES,
    );
    expect(expanded).not.toContain("UNRESOLVED");
  });
});

describe("second opinion", () => {
  it("asks a family that reviewed nothing else in the run", () => {
    // Junie's value here is gemini-3.1-pro: the only Google-family target in
    // the stack, so its disagreement is independent rather than a rubber stamp.
    const secondOpinion = /STEP 3b[\s\S]*?(?=^APPLY)/m.exec(
      buildDefaultDevPipelinePrompt(CANDIDATES),
    )?.[0];
    expect(secondOpinion).toContain("!junie:gemini-3.1-pro-preview");
    expect(secondOpinion).toContain("shares no model family");
  });

  it("only names junie models that the hosted catalog actually serves", () => {
    // ~/.junie/models/<file>.json is keyed by its `id` field, so the filename
    // ("t3-local-ollama") is never a valid target.
    const junieModels =
      CANDIDATES.find((candidate) => candidate.instanceId === "junie")?.models ?? [];
    const referenced = [
      ...buildDefaultDevPipelinePrompt(CANDIDATES).matchAll(/!junie:([\w.-]+)/g),
    ].map((match) => match[1] as string);
    expect(referenced.length).toBeGreaterThan(0);
    for (const model of referenced) {
      expect(junieModels).toContain(model);
    }
  });
});

describe("compiler edge and stress coverage", () => {
  const expand = (
    pipelinePrompt: string,
    candidates: ReadonlyArray<DevProviderCandidate> = CANDIDATES,
    promptFiles: ReadonlyArray<{ readonly name: string; readonly content: string }> = [],
  ) =>
    expandDevPipelinePrompt(
      "!dev:edge repair it",
      { scenarios: [{ name: "edge", pipelinePrompt, promptFiles }], activeScenario: "edge" },
      candidates,
    );

  it("uses an honest single-model pipeline when no delegates are available", () => {
    const prompt = buildDefaultDevPipelinePrompt([]);
    expect(prompt).toContain("Apply the minimal change yourself");
    expect(prompt).toContain("Never imply another model ran");
    expect(prompt).not.toContain("Directive:");
  });

  it("treats provider rows with empty model catalogs as unavailable", () => {
    const prompt = buildDefaultDevPipelinePrompt([
      { instanceId: "warming", name: "Warming", cli: "warming", models: [] },
    ]);
    expect(prompt).toContain("Apply the minimal change yourself");
    expect(prompt).not.toContain("Directive:");
  });

  it("degrades safely when only one target exists", () => {
    const prompt = buildDefaultDevPipelinePrompt([
      { instanceId: "solo", name: "Solo", cli: "solo", models: ["only-model"] },
    ]);
    expect(prompt.match(/Directive: !solo:only-model/g)).toHaveLength(3);
    expect(prompt.match(/no alternate ready target/g)).toHaveLength(3);
    expect(prompt).not.toContain("STEP 3b");
  });

  it("validates prompt-file directives rather than silently dropping them", () => {
    expect(expand("Use !codex:gpt-5.6-terra:review.md")).toContain(
      'UNRESOLVED: prompt file "review.md" is not attached',
    );
    expect(
      expand("Use !codex:gpt-5.6-terra:review.md", CANDIDATES, [
        { name: "review.md", content: "Review aggressively" },
      ]),
    ).toContain("with prompt file `review.md`");
  });

  it("reports provider and model ambiguity explicitly", () => {
    const ambiguousProviders = [
      { instanceId: "one", name: "Shared", cli: "same", models: ["alpha"] },
      { instanceId: "two", name: "Shared", cli: "same", models: ["alpha"] },
    ];
    expect(expand("Use !same:alpha", ambiguousProviders)).toContain(
      "provider is ambiguous: Shared, Shared",
    );
    expect(
      expand("Use !one:alpha", [
        { instanceId: "one", name: "One", cli: "one", models: ["alpha-a", "alpha-b"] },
      ]),
    ).toContain("model is ambiguous: alpha-a, alpha-b");
    expect(expand("Use !missing:alpha", ambiguousProviders)).toContain(
      'no ready provider matches "missing"',
    );
    expect(
      expand("Use !cod:missing", [
        { instanceId: "codex-main", name: "Codex Main", cli: "codex", models: ["alpha"] },
      ]),
    ).toContain("model not found");
  });

  it("rejects empty pipelines and supplies an actionable empty task", () => {
    const result = expandDevPipelinePrompt(
      "!dev:empty",
      {
        scenarios: [{ name: "empty", pipelinePrompt: "   ", promptFiles: [] }],
        activeScenario: "empty",
      },
      CANDIDATES,
    );
    expect(result).toContain("has no steps");
    expect(result).toContain("Task:\nNone provided.");
  });

  it("handles valid local-only pipelines and missing tasks without inventing delegates", () => {
    const result = expandDevPipelinePrompt(
      "!dev:local",
      {
        scenarios: [
          { name: "local", pipelinePrompt: "Inspect, edit, and verify locally.", promptFiles: [] },
        ],
        activeScenario: "local",
      },
      CANDIDATES,
    );
    expect(result).toContain("- No delegation targets. Execute with this model only.");
    expect(result).toContain("Ask the user what to build or fix before starting.");
  });

  it("reports an unknown empty-task trigger with the available scenario names", () => {
    const result = expandDevPipelinePrompt("!dev:missing", settings, CANDIDATES);
    expect(result).toContain("Available: fix, audit");
    expect(result).toContain("Task:\nNone provided.");
  });

  it("bounds directive parsing under adversarially large pipeline input", () => {
    const directives = Array.from({ length: 100 }, (_, index) => `!codex:model-${index}`).join(" ");
    const result = expand(directives, [
      {
        instanceId: "codex",
        name: "Codex",
        cli: "codex",
        models: Array.from({ length: 100 }, (_, index) => `model-${index}`),
      },
    ]);
    expect(result.match(/→ target/g)).toHaveLength(64);
    expect(result).not.toContain("model-64`");
  });

  it("derives every valid model from ready providers without truncating the catalog", () => {
    const readyModels = [
      ...Array.from({ length: 45 }, (_, index) => ({ slug: `model-${index}` })),
      { slug: "invalid model with spaces" },
    ];
    const provider = (overrides: Record<string, unknown>) =>
      ({
        instanceId: "codex-main",
        displayName: null,
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: readyModels,
        ...overrides,
      }) as never;
    const result = deriveDevProviderCandidates([
      provider({}),
      provider({ instanceId: "disabled", enabled: false }),
      provider({ instanceId: "missing", installed: false }),
      provider({ instanceId: "error", status: "error" }),
      provider({ instanceId: "unavailable", availability: "unavailable" }),
      provider({ instanceId: "empty", models: [{ slug: "invalid model" }] }),
      provider({
        instanceId: "custom-driver",
        displayName: "Custom Driver",
        driver: "vendor-runtime",
        models: [{ slug: "vendor-model" }],
      }),
    ]);
    expect(result).toEqual([
      {
        instanceId: "codex-main",
        name: "codex-main",
        cli: "codex",
        models: Array.from({ length: 45 }, (_, index) => `model-${index}`),
      },
      {
        instanceId: "custom-driver",
        name: "Custom Driver",
        cli: "vendor-runtime",
        models: ["vendor-model"],
      },
    ]);
  });
});

describe("pipeline orchestrator capability", () => {
  it("allows only adapters that inject the thread MCP credential", () => {
    expect(providerDriverSupportsPipelineOrchestration("claudeAgent")).toBe(true);
    expect(providerDriverSupportsPipelineOrchestration("codex")).toBe(true);
    expect(providerDriverSupportsPipelineOrchestration("cursor")).toBe(true);
    expect(providerDriverSupportsPipelineOrchestration("grok")).toBe(true);
    expect(providerDriverSupportsPipelineOrchestration("opencode")).toBe(true);
    expect(providerDriverSupportsPipelineOrchestration("agy")).toBe(false);
    expect(providerDriverSupportsPipelineOrchestration("junie")).toBe(false);
  });
});
