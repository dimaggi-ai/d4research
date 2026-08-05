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

export function applyOllamaClaudePreset(
  instance: ProviderInstanceConfig,
  discoveredLocalModels: ReadonlyArray<string> = [],
): ProviderInstanceConfig {
  const replacedNames = new Set(OLLAMA_ENVIRONMENT.map((variable) => variable.name));
  const environment = [
    ...(instance.environment ?? []).filter((variable) => !replacedNames.has(variable.name)),
    ...OLLAMA_ENVIRONMENT,
  ];
  const config = configRecord(instance.config);
  const existingModels = Array.isArray(config.customModels)
    ? config.customModels.filter((model): model is string => typeof model === "string")
    : [];
  const local = discoveredLocalModels.map((id) => id.trim()).filter((id) => id.length > 0);

  return {
    ...instance,
    driver: ProviderDriverKind.make("claudeAgent"),
    environment,
    config: {
      ...config,
      customModels: [...new Set([...existingModels, ...local, ...OLLAMA_CLAUDE_CLOUD_MODELS])],
    },
  };
}

const OLLAMA_LOCAL_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const OLLAMA_LOCAL_DISCOVERY_TIMEOUT_MS = 3_000;

/**
 * Query the local Ollama daemon for installed model tags. Returns an empty
 * array if the daemon is unreachable, the request times out, or the payload
 * is unexpected — callers should still fall through to the cloud model list.
 */
export async function fetchLocalOllamaModelIds(): Promise<ReadonlyArray<string>> {
  if (typeof fetch !== "function") return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_LOCAL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(OLLAMA_LOCAL_TAGS_URL, { signal: controller.signal });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return [];
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    const ids: string[] = [];
    for (const entry of models) {
      if (entry && typeof entry === "object") {
        const name = (entry as { name?: unknown; model?: unknown }).name;
        const model = (entry as { model?: unknown }).model;
        const id = typeof name === "string" ? name : typeof model === "string" ? model : null;
        if (id && id.length > 0) ids.push(id);
      }
    }
    return ids;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
