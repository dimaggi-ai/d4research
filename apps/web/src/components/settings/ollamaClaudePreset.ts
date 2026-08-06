import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";

/**
 * Last-resort roster used only when neither live source (the server's own
 * `ollama list` discovery nor the daemon's `/api/tags`) answers. Kept in sync
 * with the tags Ollama Cloud published as of 2026-08; live discovery always
 * wins, so a stale entry here can only ever be an extra suggestion.
 */
export const OLLAMA_CLAUDE_CLOUD_MODELS = [
  "glm-5.2:cloud",
  "kimi-k3:cloud",
  "kimi-k2.7-code:cloud",
  "kimi-k2.6:cloud",
  "minimax-m2.7:cloud",
  "nemotron-3-super:cloud",
  "qwen3.5:cloud",
  "gpt-oss:20b-cloud",
] as const;

export const OLLAMA_ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";

/**
 * The variables `ollama launch claude` exports (verified against ollama
 * 0.32.4): the Anthropic-compatible endpoint plus the sentinel auth token.
 * `ANTHROPIC_API_KEY` is blanked so a real Anthropic key on the server process
 * cannot shadow the sentinel.
 */
const OLLAMA_ENVIRONMENT: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
  { name: "ANTHROPIC_AUTH_TOKEN", value: "ollama", sensitive: false },
  { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
  { name: "ANTHROPIC_BASE_URL", value: OLLAMA_ANTHROPIC_BASE_URL, sensitive: false },
];

/**
 * Claude Code resolves its `haiku`/`sonnet`/`opus` aliases for background work
 * (titles, summaries, subagents) even when the user picks an explicit model.
 * Against Ollama those aliases are unknown models, so `ollama launch claude`
 * pins all three to the selected tag — mirror that or every background call
 * fails.
 */
const OLLAMA_DEFAULT_MODEL_VARIABLES = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
] as const;

function configRecord(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

/** Prefer a cloud coding tag as the alias target, else any discovered model. */
export function pickOllamaAliasModel(models: ReadonlyArray<string>): string | null {
  return (
    models.find((model) => model === "glm-5.2:cloud") ??
    models.find((model) => /:cloud$|-cloud$/u.test(model)) ??
    models[0] ??
    null
  );
}

export function applyOllamaClaudePreset(
  instance: ProviderInstanceConfig,
  discoveredLocalModels: ReadonlyArray<string> = [],
): ProviderInstanceConfig {
  const local = discoveredLocalModels.map((id) => id.trim()).filter((id) => id.length > 0);
  // Live discovery is authoritative; the bundled roster is only a suggestion
  // for the case where the daemon could not be reached at all.
  const models = local.length > 0 ? local : [...OLLAMA_CLAUDE_CLOUD_MODELS];
  const aliasModel = pickOllamaAliasModel(models);
  const aliasEnvironment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = aliasModel
    ? OLLAMA_DEFAULT_MODEL_VARIABLES.map((name) => ({
        name,
        value: aliasModel,
        sensitive: false,
      }))
    : [];

  const replacedNames = new Set([
    ...OLLAMA_ENVIRONMENT.map((variable) => variable.name),
    ...aliasEnvironment.map((variable) => variable.name),
  ]);
  const environment = [
    ...(instance.environment ?? []).filter((variable) => !replacedNames.has(variable.name)),
    ...OLLAMA_ENVIRONMENT,
    ...aliasEnvironment,
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
      customModels: [...new Set([...existingModels, ...models])],
    },
  };
}

const OLLAMA_LOCAL_DISCOVERY_TIMEOUT_MS = 3_000;

export type OllamaDiscoveryResult = {
  readonly models: ReadonlyArray<string>;
  /** False when no candidate host answered — the caller should warn the user. */
  readonly reachable: boolean;
};

/**
 * Candidate daemon origins, in order. `127.0.0.1` is correct when the browser
 * and the Ollama daemon share a machine; when the UI is opened from another
 * device (tablet, phone) loopback resolves to *that* device, so fall back to
 * the host serving the app, which is where the T3 server — and therefore
 * Ollama — actually runs.
 */
export function ollamaDiscoveryOrigins(location?: {
  readonly protocol?: string;
  readonly hostname?: string;
}): ReadonlyArray<string> {
  const origins = [OLLAMA_ANTHROPIC_BASE_URL];
  const hostname = location?.hostname;
  if (hostname && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
    const protocol = location?.protocol === "https:" ? "https" : "http";
    origins.push(`${protocol}://${hostname}:11434`);
  }
  return origins;
}

/** Extract model slugs from an Ollama `GET /api/tags` payload. */
export function parseOllamaTagsPayload(payload: unknown): ReadonlyArray<string> {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const { name, model } = entry as { name?: unknown; model?: unknown };
    const id = typeof name === "string" && name.length > 0 ? name : model;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

async function fetchTagsFrom(origin: string): Promise<ReadonlyArray<string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_LOCAL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/tags`, { signal: controller.signal });
    if (!response.ok) return null;
    return parseOllamaTagsPayload((await response.json()) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query the local Ollama daemon for installed model tags, trying loopback then
 * the host serving the app. `reachable` is false when every candidate failed,
 * which is the signal the settings card uses to warn instead of silently
 * writing the bundled roster.
 */
export async function discoverOllamaModels(
  origins: ReadonlyArray<string> = ollamaDiscoveryOrigins(
    typeof window === "undefined" ? undefined : window.location,
  ),
): Promise<OllamaDiscoveryResult> {
  if (typeof fetch !== "function") return { models: [], reachable: false };
  for (const origin of origins) {
    const models = await fetchTagsFrom(origin);
    if (models !== null) return { models, reachable: true };
  }
  return { models: [], reachable: false };
}

/** Back-compat shim for callers that only need the slug list. */
export async function fetchLocalOllamaModelIds(): Promise<ReadonlyArray<string>> {
  return (await discoverOllamaModels()).models;
}

export function isOllamaClaudePresetConfigured(instance: ProviderInstanceConfig): boolean {
  const values = new Map((instance.environment ?? []).map(({ name, value }) => [name, value]));
  const baseUrl = values.get("ANTHROPIC_BASE_URL")?.trim().replace(/\/+$/u, "");
  return (
    instance.driver === ProviderDriverKind.make("claudeAgent") &&
    values.get("ANTHROPIC_AUTH_TOKEN") === "ollama" &&
    baseUrl !== undefined &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):11434$/u.test(baseUrl)
  );
}
