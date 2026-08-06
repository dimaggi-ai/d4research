import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  deriveResearchProviderCandidates,
  expandDeepResearchPrompt,
  isDeepResearchPrompt,
  sanitizeResearchModelSlugs,
} from "./researchMode";

describe("research mode", () => {
  it("recognizes the deep research tag only at the start", () => {
    expect(isDeepResearchPrompt("  #deep-research compare runtimes")).toBe(true);
    expect(isDeepResearchPrompt("mention #deep-research later")).toBe(false);
  });

  it("expands a tagged prompt with bounded roles, memory, and ready CLIs", () => {
    const prompt = expandDeepResearchPrompt("#deep-research compare runtimes", [
      { name: "Claude", cli: "claude", models: ["sonnet"] },
      { name: "Junie", cli: "junie", models: ["custom:local"] },
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
      { name: "Claude", cli: "claude", models: ["sonnet"] },
    ]);
  });
});
