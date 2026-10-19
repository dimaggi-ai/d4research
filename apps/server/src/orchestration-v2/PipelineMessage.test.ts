import { describe, expect, it } from "vite-plus/test";
import { expandProviderDevMessage, expandProviderResearchMessage } from "./PipelineMessage.ts";

describe("expandProviderDevMessage", () => {
  const settings = {
    scenarios: [{ name: "default", pipelinePrompt: "STEP 1\nDo it here.", promptFiles: [] }],
    activeScenario: "default",
  };

  it("keeps a Claude effort prefix while expanding the trigger beneath it", () => {
    const expanded = expandProviderDevMessage("Ultrathink:\n!dev:default fix it", settings, []);
    expect(expanded).toMatch(/^Ultrathink:\n!dev:default/);
    expect(expanded).toContain("Dev pipeline protocol (non-negotiable):");
    expect(expanded).toContain("Task:\nfix it");
  });

  it("leaves ordinary prefixed prompts unchanged", () => {
    expect(expandProviderDevMessage("Ultrathink:\nexplain it", settings, [])).toBe(
      "Ultrathink:\nexplain it",
    );
  });
});

describe("expandProviderResearchMessage", () => {
  const settings = {
    scenarios: [
      {
        name: "private",
        pipelinePrompt: "STEP 1\nUse the confidential review rubric.",
        promptFiles: [],
      },
    ],
    activeScenario: "private",
    pipelinePrompt: "",
    promptFiles: [],
  };

  it("keeps a Claude effort prefix while expanding the trigger beneath it", () => {
    const expanded = expandProviderResearchMessage(
      "Ultrathink:\n!research:private audit it",
      settings,
      [],
    );
    expect(expanded).toMatch(/^Ultrathink:\n!research:private/);
    expect(expanded).toContain("Execution protocol (non-negotiable):");
    expect(expanded).toContain("Use the confidential review rubric.");
    expect(expanded).toContain("Research task:\naudit it");
  });

  it("leaves ordinary prefixed prompts unchanged", () => {
    expect(expandProviderResearchMessage("Ultrathink:\nexplain it", settings, [])).toBe(
      "Ultrathink:\nexplain it",
    );
  });
});
