import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  deriveResearchProviderCandidates,
  describeParallelStageNotes,
  expandDeepResearchPrompt,
  isDeepResearchPrompt,
  resolveResearchStages,
  sanitizeResearchModelSlugs,
} from "./researchMode";

describe("research mode", () => {
  it("recognizes the deep research tag only at the start", () => {
    expect(isDeepResearchPrompt("  #deep-research compare runtimes")).toBe(true);
    expect(isDeepResearchPrompt("mention #deep-research later")).toBe(false);
  });

  it("expands a tagged prompt with bounded roles, memory, and ready CLIs", () => {
    const prompt = expandDeepResearchPrompt("#deep-research compare runtimes", [
      { instanceId: "claude", name: "Claude", cli: "claude", models: ["sonnet"] },
      { instanceId: "junie", name: "Junie", cli: "junie", models: ["custom:local"] },
    ]);

    expect(prompt).toContain("at most three delegated agents concurrently");
    expect(prompt).toContain("memory_remember");
    expect(prompt).toContain("Scout: find primary evidence");
    expect(prompt).toContain("Claude: CLI `claude`; models: sonnet");
    expect(prompt).toContain("Research task:\ncompare runtimes");
  });

  it("asks the lead to track stages as plan steps", () => {
    const prompt = expandDeepResearchPrompt("#deep-research compare runtimes", []);
    expect(prompt).toContain("Track progress in your plan/todo tool");
    expect(prompt).toContain("Gather primary evidence");
  });

  it("drops malformed model slugs and caps the advertised list", () => {
    expect(
      sanitizeResearchModelSlugs([
        "gemini-3.6-flash-high",
        "⠋ Fetching available models...\r⠙ Fetching available models...",
        "gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
        "opencode/big-pickle",
      ]),
    ).toEqual(["gemini-3.6-flash-high", "opencode/big-pickle"]);

    expect(sanitizeResearchModelSlugs(["a", "b", "c", "d", "e", "f", "g", "h"]).length).toBe(6);
  });

  it("only advertises ready enabled provider instances", () => {
    const makeEntry = (status: "ready" | "disabled", enabled = true) => ({
      instanceId: ProviderInstanceId.make(`claude-${status}`),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled,
      installed: true,
      status,
      isDefault: true,
      isAvailable: true,
      snapshot: {} as never,
      models: [{ slug: "sonnet" } as never],
    });

    expect(deriveResearchProviderCandidates([makeEntry("ready"), makeEntry("disabled")])).toEqual([
      { instanceId: "claude-ready", name: "Claude", cli: "claude", models: ["sonnet"] },
    ]);
  });

  it("builds the stage list from configured stages, skipping disabled ones", () => {
    const prompt = expandDeepResearchPrompt(
      "#deep-research compare runtimes",
      [],
      [
        { id: "a", title: "Survey literature", goal: "Find prior art.", enabled: true },
        { id: "b", title: "Skipped stage", goal: "", enabled: false },
        { id: "c", title: "Write it up", goal: "", enabled: true },
      ],
    );
    expect(prompt).toContain("1. Survey literature — Find prior art.");
    expect(prompt).toContain("2. Write it up");
    expect(prompt).not.toContain("Skipped stage");
    expect(prompt).toContain("create one step per stage below using its exact title");
  });

  it("falls back to the default stages when everything is disabled", () => {
    const prompt = expandDeepResearchPrompt(
      "#deep-research q",
      [],
      [{ id: "a", title: "Only stage", goal: "", enabled: false }],
    );
    expect(prompt).toContain("Gather primary evidence");
  });

  it("renders parallel groups as honest interleaving notes", () => {
    const stages = [
      { id: "a", title: "A", goal: "", enabled: true, parallelGroup: 1 },
      { id: "b", title: "B", goal: "", enabled: true, parallelGroup: 1 },
      { id: "c", title: "C", goal: "", enabled: true },
    ];
    expect(describeParallelStageNotes(stages)).toEqual([
      "Stages 1 and 2 are independent and may be worked in either order or interleaved.",
    ]);
    const prompt = expandDeepResearchPrompt("#deep-research q", [], stages);
    expect(prompt).toContain("Stages 1 and 2 are independent");
  });

  it("marks per-stage provider picks as suggestions, never as ran", () => {
    const prompt = expandDeepResearchPrompt(
      "#deep-research q",
      [{ instanceId: "junie", name: "Junie", cli: "junie", models: ["gemini-3.1-pro"] }],
      [
        {
          id: "lit",
          title: "Literature",
          goal: "",
          enabled: true,
          suggestedInstanceId: "junie" as never,
          suggestedModel: "gemini-3.1-pro",
        },
      ],
    );
    expect(prompt).toContain("Suggested for this stage: Junie / gemini-3.1-pro");
    expect(prompt).toContain("a suggestion only");
    expect(prompt).toContain("Never claim it ran unless it did");
  });

  it("drops a suggestion whose model slug is malformed", () => {
    const prompt = expandDeepResearchPrompt(
      "#deep-research q",
      [],
      [
        {
          id: "lit",
          title: "Literature",
          goal: "",
          enabled: true,
          suggestedInstanceId: "junie" as never,
          suggestedModel: "⠋ Fetching available models...",
        },
      ],
    );
    expect(prompt).not.toContain("Suggested for this stage");
  });

  it("resolves configured stages with the default fallback", () => {
    expect(resolveResearchStages(undefined).map((stage) => stage.id)).toEqual([
      "scope",
      "gather",
      "test",
      "challenge",
      "synthesize",
    ]);
  });
});
