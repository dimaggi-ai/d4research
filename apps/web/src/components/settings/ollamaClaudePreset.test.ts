import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOllamaClaudePreset,
  discoverOllamaModels,
  isOllamaClaudePresetConfigured,
  OLLAMA_CLAUDE_CLOUD_MODELS,
  OLLAMA_PRESET_BACKUP_KEY,
  ollamaDiscoveryOrigins,
  parseOllamaTagsPayload,
  pickOllamaAliasModel,
  removeOllamaClaudePreset,
} from "./ollamaClaudePreset";

const claudeInstance = (
  overrides: Partial<ProviderInstanceConfig> = {},
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  ...overrides,
});

describe("Ollama Claude preset", () => {
  it("preserves unrelated settings while replacing Ollama variables", () => {
    const input = claudeInstance({
      displayName: "Work Claude",
      environment: [
        { name: "KEEP_ME", value: "yes", sensitive: false },
        { name: "ANTHROPIC_BASE_URL", value: "https://old.example", sensitive: false },
      ],
      config: { binaryPath: "/bin/claude", customModels: ["existing-model"] },
    });

    const result = applyOllamaClaudePreset(input, ["glm-5.2:cloud"]);

    expect(result.displayName).toBe("Work Claude");
    expect(result.environment).toContainEqual({ name: "KEEP_ME", value: "yes", sensitive: false });
    expect(result.environment?.filter(({ name }) => name === "ANTHROPIC_BASE_URL")).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:11434", sensitive: false },
    ]);
    expect((result.config as { customModels: ReadonlyArray<string> }).customModels).toEqual([
      "existing-model",
      "glm-5.2:cloud",
    ]);
    expect(isOllamaClaudePresetConfigured(result)).toBe(true);
  });

  it("prefers live discovery over the bundled roster and keeps :cloud tags intact", () => {
    const discovered = ["gemma4:e4b", "glm-5.2:cloud", "gpt-oss:20b-cloud"];
    const result = applyOllamaClaudePreset(claudeInstance(), discovered);
    const models = (result.config as { customModels: ReadonlyArray<string> }).customModels;

    expect(models).toEqual(discovered);
    expect(models).not.toContain("qwen3.5:cloud");
    expect(models.filter((model) => model.includes(":cloud"))).toEqual(["glm-5.2:cloud"]);
  });

  it("falls back to the bundled roster only when discovery returned nothing", () => {
    const result = applyOllamaClaudePreset(claudeInstance(), []);
    expect((result.config as { customModels: ReadonlyArray<string> }).customModels).toEqual([
      ...OLLAMA_CLAUDE_CLOUD_MODELS,
    ]);
  });

  it("pins the Claude alias models so background haiku/sonnet calls resolve", () => {
    const result = applyOllamaClaudePreset(claudeInstance(), ["gemma4:e4b", "kimi-k3:cloud"]);
    const values = new Map((result.environment ?? []).map(({ name, value }) => [name, value]));

    expect(values.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")).toBe("kimi-k3:cloud");
    expect(values.get("ANTHROPIC_DEFAULT_SONNET_MODEL")).toBe("kimi-k3:cloud");
    expect(values.get("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe("kimi-k3:cloud");
  });

  it("prefers a cloud tag as the alias target, then any model", () => {
    expect(pickOllamaAliasModel(["gemma4:e4b", "glm-5.2:cloud"])).toBe("glm-5.2:cloud");
    expect(pickOllamaAliasModel(["gemma4:e4b", "gpt-oss:20b-cloud"])).toBe("gpt-oss:20b-cloud");
    expect(pickOllamaAliasModel(["gemma4:e4b"])).toBe("gemma4:e4b");
    expect(pickOllamaAliasModel([])).toBe(null);
  });

  it("recognizes the environment `ollama launch claude` exports", () => {
    expect(
      isOllamaClaudePresetConfigured(
        claudeInstance({
          environment: [
            { name: "ANTHROPIC_AUTH_TOKEN", value: "ollama", sensitive: false },
            { name: "ANTHROPIC_BASE_URL", value: "http://localhost:11434/", sensitive: false },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isOllamaClaudePresetConfigured(
        claudeInstance({
          environment: [
            { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-ant-real", sensitive: true },
            { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:11434", sensitive: false },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("Ollama tag discovery", () => {
  it("parses /api/tags payloads, keeping cloud tags and deduping", () => {
    expect(
      parseOllamaTagsPayload({
        models: [
          { name: "glm-5.2:cloud", model: "glm-5.2:cloud", remote_host: "https://ollama.com:443" },
          { model: "gemma4:e4b" },
          { name: "glm-5.2:cloud" },
          { name: "" },
          null,
        ],
      }),
    ).toEqual(["glm-5.2:cloud", "gemma4:e4b"]);
    expect(parseOllamaTagsPayload({ models: "nope" })).toEqual([]);
    expect(parseOllamaTagsPayload(null)).toEqual([]);
  });

  it("falls back from loopback to the host serving the app for remote browsers", () => {
    expect(
      ollamaDiscoveryOrigins({ protocol: "https:", hostname: "cacheos.example.ts.net" }),
    ).toEqual(["http://127.0.0.1:11434", "https://cacheos.example.ts.net:11434"]);
    expect(ollamaDiscoveryOrigins({ protocol: "http:", hostname: "localhost" })).toEqual([
      "http://127.0.0.1:11434",
    ]);
  });

  it("reports unreachable when every candidate origin fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    try {
      expect(await discoverOllamaModels(["http://127.0.0.1:11434"])).toEqual({
        models: [],
        reachable: false,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns the first origin that answers", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = ((input: string) => {
      seen.push(String(input));
      if (String(input).includes("127.0.0.1")) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "glm-5.2:cloud" }] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    try {
      expect(
        await discoverOllamaModels(["http://127.0.0.1:11434", "http://host.example:11434"]),
      ).toEqual({ models: ["glm-5.2:cloud"], reachable: true });
      expect(seen).toEqual([
        "http://127.0.0.1:11434/api/tags",
        "http://host.example:11434/api/tags",
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("removeOllamaClaudePreset", () => {
  it("round-trips an instance that had nothing configured before", () => {
    const original = claudeInstance({ config: { binaryPath: "claude", customModels: [] } });
    const applied = applyOllamaClaudePreset(original, ["glm-5.2:cloud"]);
    expect(isOllamaClaudePresetConfigured(applied)).toBe(true);

    const reverted = removeOllamaClaudePreset(applied, ["glm-5.2:cloud"]);
    expect(isOllamaClaudePresetConfigured(reverted)).toBe(false);
    expect(reverted).toEqual(original);
  });

  it("removes every variable the preset writes, including the blanked API key", () => {
    const applied = applyOllamaClaudePreset(claudeInstance(), ["glm-5.2:cloud"]);
    const reverted = removeOllamaClaudePreset(applied);
    expect(reverted.environment).toBeUndefined();
  });

  it("keeps environment variables the user set themselves", () => {
    const applied = applyOllamaClaudePreset(
      claudeInstance({
        environment: [{ name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false }],
      }),
      ["glm-5.2:cloud"],
    );
    expect(removeOllamaClaudePreset(applied).environment).toEqual([
      { name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false },
    ]);
  });

  it("strips the bundled roster written when the daemon was unreachable", () => {
    const applied = applyOllamaClaudePreset(claudeInstance(), []);
    expect(applied.config).toMatchObject({ customModels: [...OLLAMA_CLAUDE_CLOUD_MODELS] });
    expect(removeOllamaClaudePreset(applied).config).toMatchObject({ customModels: [] });
  });

  it("restores the snapshot regardless of what discovery reports today", () => {
    const applied = applyOllamaClaudePreset(claudeInstance(), ["llama4:latest"]);
    expect(removeOllamaClaudePreset(applied, ["llama4:latest"]).config).toMatchObject({
      customModels: [],
    });
    expect(removeOllamaClaudePreset(applied, []).config).toMatchObject({
      customModels: [],
    });
  });

  it("restores pre-preset managed variables and models from the snapshot", () => {
    // The exact scenario the adversarial review probed: values that existed
    // before the preset must survive an apply → remove round trip.
    const original = claudeInstance({
      environment: [
        { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "my-old-haiku", sensitive: false },
        { name: "ANTHROPIC_BASE_URL", value: "https://old.example", sensitive: false },
      ],
      config: { customModels: ["gemma4:e4b-it-qat"] },
    });
    const reverted = removeOllamaClaudePreset(
      applyOllamaClaudePreset(original, ["glm-5.2:cloud", "gemma4:e4b-it-qat"]),
      ["glm-5.2:cloud", "gemma4:e4b-it-qat"],
    );
    expect(reverted.environment).toEqual(
      expect.arrayContaining([
        { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "my-old-haiku", sensitive: false },
        { name: "ANTHROPIC_BASE_URL", value: "https://old.example", sensitive: false },
      ]),
    );
    expect(reverted.config).toMatchObject({ customModels: ["gemma4:e4b-it-qat"] });
  });

  it("falls back to the preset-model filter when no snapshot exists", () => {
    const applied = applyOllamaClaudePreset(claudeInstance(), ["llama4:latest"]);
    const legacy = {
      ...applied,
      config: Object.fromEntries(
        Object.entries(applied.config as Record<string, unknown>).filter(
          ([key]) => key !== OLLAMA_PRESET_BACKUP_KEY,
        ),
      ),
    };
    expect(removeOllamaClaudePreset(legacy, []).config).toMatchObject({
      customModels: ["llama4:latest"],
    });
  });

  it("filters embedding-only models out of tags payloads", () => {
    expect(
      parseOllamaTagsPayload({
        models: [
          { name: "glm-5.2:cloud" },
          { name: "mxbai-embed-large:latest" },
          { name: "nomic-embed-text:latest" },
        ],
      }),
    ).toEqual(["glm-5.2:cloud"]);
  });

  it("preserves custom Anthropic models the user added", () => {
    const original = claudeInstance({ config: { customModels: ["claude-opus-5[1m]"] } });
    const applied = applyOllamaClaudePreset(original, ["glm-5.2:cloud"]);
    expect(removeOllamaClaudePreset(applied, ["glm-5.2:cloud"]).config).toMatchObject({
      customModels: ["claude-opus-5[1m]"],
    });
  });

  it("is a no-op on an instance that never had the preset applied", () => {
    const untouched = claudeInstance({ config: { customModels: ["claude-opus-5[1m]"] } });
    expect(removeOllamaClaudePreset(untouched)).toEqual(untouched);
  });
});
