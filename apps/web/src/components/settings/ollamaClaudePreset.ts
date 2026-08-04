import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";

export const OLLAMA_CLAUDE_CLOUD_MODELS = [
  "kimi-k2.5:cloud",
  "glm-5:cloud",
  "minimax-m2.7:cloud",
  "qwen3.5:cloud",
] as const;

const OLLAMA_ENVIRONMENT: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
  { name: "ANTHROPIC_AUTH_TOKEN", value: "ollama", sensitive: false },
  { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
  { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:11434", sensitive: false },
];

function configRecord(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

export function applyOllamaClaudePreset(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  const replacedNames = new Set(OLLAMA_ENVIRONMENT.map((variable) => variable.name));
  const environment = [
    ...(instance.environment ?? []).filter((variable) => !replacedNames.has(variable.name)),
    ...OLLAMA_ENVIRONMENT,
  ];
  const config = configRecord(instance.config);
  const existingModels = Array.isArray(config.customModels)
    ? config.customModels.filter((model): model is string => typeof model === "string")
    : [];

  return {
    ...instance,
    driver: ProviderDriverKind.make("claudeAgent"),
    environment,
    config: {
      ...config,
      customModels: [...new Set([...existingModels, ...OLLAMA_CLAUDE_CLOUD_MODELS])],
    },
  };
}

export function isOllamaClaudePresetConfigured(instance: ProviderInstanceConfig): boolean {
  const values = new Map((instance.environment ?? []).map(({ name, value }) => [name, value]));
  return (
    instance.driver === ProviderDriverKind.make("claudeAgent") &&
    values.get("ANTHROPIC_AUTH_TOKEN") === "ollama" &&
    values.get("ANTHROPIC_API_KEY") === "" &&
    values.get("ANTHROPIC_BASE_URL") === "http://127.0.0.1:11434"
  );
}
