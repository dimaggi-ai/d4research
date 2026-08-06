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

  // Snapshot what the preset is about to replace, once: removing the preset
  // restores this instead of guessing. A refresh (preset already applied)
  // must not overwrite the snapshot with preset-managed state.
  const backup =
    config[OLLAMA_PRESET_BACKUP_KEY] ??
    ({
      environment: (instance.environment ?? []).filter((variable) =>
        OLLAMA_MANAGED_VARIABLES.includes(variable.name),
      ),
      customModels: existingModels,
    } satisfies OllamaPresetBackup);

  return {
    ...instance,
    driver: ProviderDriverKind.make("claudeAgent"),
    environment,
    config: {
      ...config,
      customModels: [...new Set([...existingModels, ...models])],
      [OLLAMA_PRESET_BACKUP_KEY]: backup,
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

// Embedding models answer /api/embed, not the chat endpoint — selecting one
// as a Claude chat model guarantees a failed turn. The tags payload carries no
// capability flag, so recognize them by the naming convention embedders follow.
// (Mirrors the server-side filter in ClaudeProvider.ts.)
const OLLAMA_EMBEDDING_MODEL_PATTERN = /embed|minilm|reranker/iu;

/** Extract chat-capable model slugs from an Ollama `GET /api/tags` payload. */
export function parseOllamaTagsPayload(payload: unknown): ReadonlyArray<string> {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const { name, model } = entry as { name?: unknown; model?: unknown };
    const id = typeof name === "string" && name.length > 0 ? name : model;
    if (typeof id === "string" && id.length > 0 && !OLLAMA_EMBEDDING_MODEL_PATTERN.test(id)) {
      ids.push(id);
    }
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

/**
 * Every variable the preset writes. Reverting removes these outright rather
 * than blanking them: an empty `ANTHROPIC_API_KEY` still shadows the key the
 * server process carries, so a blanked one leaves Claude just as unusable as
 * the preset did.
 */
const OLLAMA_MANAGED_VARIABLES: ReadonlyArray<string> = [
  ...OLLAMA_ENVIRONMENT.map((variable) => variable.name),
  ...OLLAMA_DEFAULT_MODEL_VARIABLES,
];

/**
 * Where the preset stashes the state it replaced. The contracts envelope keeps
 * driver config opaque (`Schema.Unknown`), so an extra key rides along in the
 * stored instance config; the server-side driver decode simply ignores it.
 */
export const OLLAMA_PRESET_BACKUP_KEY = "ollamaPresetBackup";

export interface OllamaPresetBackup {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly customModels: ReadonlyArray<string>;
}

function readPresetBackup(config: Record<string, unknown>): OllamaPresetBackup | null {
  const backup = config[OLLAMA_PRESET_BACKUP_KEY];
  if (backup === null || typeof backup !== "object" || Array.isArray(backup)) return null;
  const { environment, customModels } = backup as Partial<OllamaPresetBackup>;
  if (!Array.isArray(environment) || !Array.isArray(customModels)) return null;
  return {
    environment: environment.filter(
      (variable): variable is ProviderInstanceEnvironmentVariable =>
        variable !== null &&
        typeof variable === "object" &&
        typeof (variable as { name?: unknown }).name === "string" &&
        typeof (variable as { value?: unknown }).value === "string",
    ),
    customModels: customModels.filter((model): model is string => typeof model === "string"),
  };
}

/**
 * Whether a custom model came from the preset. The driver config schema is a
 * closed struct, so the applied tags cannot be recorded alongside them — but
 * Ollama tags are recognisable: they are either in the bundled roster or carry
 * a `:cloud`/`-cloud` suffix, neither of which a hand-entered Anthropic model
 * slug ever does.
 */
export function isOllamaPresetModel(model: string): boolean {
  const id = model.trim();
  return (
    (OLLAMA_CLAUDE_CLOUD_MODELS as ReadonlyArray<string>).includes(id) ||
    /:cloud$|-cloud$/u.test(id)
  );
}

/**
 * Undo {@link applyOllamaClaudePreset}, returning the instance to whatever it
 * was before Ollama was switched on. Pass the models discovery currently
 * reports so locally pulled tags (which carry no `:cloud` marker) are cleaned
 * up too; without it only recognisable tags are removed and anything the user
 * typed themselves is preserved either way.
 */
export function removeOllamaClaudePreset(
  instance: ProviderInstanceConfig,
  discoveredLocalModels: ReadonlyArray<string> = [],
): ProviderInstanceConfig {
  const discovered = new Set(discoveredLocalModels.map((id) => id.trim()).filter(Boolean));
  const managed = new Set(OLLAMA_MANAGED_VARIABLES);
  const config = configRecord(instance.config);
  const backup = readPresetBackup(config);
  delete config[OLLAMA_PRESET_BACKUP_KEY];

  const environment = [
    ...(instance.environment ?? []).filter((variable) => !managed.has(variable.name)),
    // Restore whatever managed variables the preset originally replaced.
    ...(backup?.environment ?? []),
  ];
  const existingModels = Array.isArray(config.customModels)
    ? config.customModels.filter((model): model is string => typeof model === "string")
    : [];
  // With a snapshot the previous model list comes back verbatim; without one
  // (preset applied before snapshots existed) fall back to filtering out what
  // looks preset-added.
  const customModels =
    backup?.customModels ??
    existingModels.filter((model) => !isOllamaPresetModel(model) && !discovered.has(model.trim()));

  const next: ProviderInstanceConfig = {
    ...instance,
    config: { ...config, customModels },
  };
  // An empty list is the schema default; keeping the key absent matches how an
  // instance that never had the preset applied is persisted.
  if (environment.length > 0) return { ...next, environment };
  const { environment: _dropped, ...withoutEnvironment } = next;
  return withoutEnvironment;
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
