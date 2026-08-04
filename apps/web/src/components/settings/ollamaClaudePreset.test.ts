import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOllamaClaudePreset,
  isOllamaClaudePresetConfigured,
  OLLAMA_CLAUDE_CLOUD_MODELS,
} from "./ollamaClaudePreset";

describe("Ollama Claude preset", () => {
  it("preserves unrelated settings while replacing Ollama variables and adding cloud models", () => {
    const input: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Work Claude",
      environment: [
        { name: "KEEP_ME", value: "yes", sensitive: false },
        { name: "ANTHROPIC_BASE_URL", value: "https://old.example", sensitive: false },
      ],
      config: { binaryPath: "/bin/claude", customModels: ["existing-model"] },
    };

    const result = applyOllamaClaudePreset(input);

    expect(result.displayName).toBe("Work Claude");
    expect(result.environment).toContainEqual({ name: "KEEP_ME", value: "yes", sensitive: false });
    expect(result.environment?.filter(({ name }) => name === "ANTHROPIC_BASE_URL")).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:11434", sensitive: false },
    ]);
    expect((result.config as { customModels: ReadonlyArray<string> }).customModels).toEqual([
      "existing-model",
      ...OLLAMA_CLAUDE_CLOUD_MODELS,
    ]);
    expect(isOllamaClaudePresetConfigured(result)).toBe(true);
  });
});
