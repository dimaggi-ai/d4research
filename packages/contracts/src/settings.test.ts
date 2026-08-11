import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.agy).toEqual({
      enabled: true,
      binaryPath: "agy",
      defaultModel: "gemini-3.6-flash-medium",
      launchArgs: "",
      customModels: [],
    });
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings memory connectors", () => {
  it("defaults local Memo on", () => {
    const settings = decodeServerSettings({});
    expect(settings.memory).toEqual({
      localEnabled: true,
      localBackend: "builtin",
      localBaseUrl: "http://127.0.0.1:8099",
    });
  });

  it("accepts partial memory connector patches", () => {
    expect(decodeServerSettingsPatch({ memory: { localEnabled: false } }).memory).toEqual({
      localEnabled: false,
    });
  });

  it("ignores removed hosted Meko fields in persisted settings", () => {
    expect(
      decodeServerSettings({
        memory: { mekoEnabled: true, mekoMcpUrl: "https://mcp.mekodata.ai/mcp" },
      }).memory,
    ).toEqual({
      localEnabled: true,
      localBackend: "builtin",
      localBaseUrl: "http://127.0.0.1:8099",
    });
  });
});

describe("ServerSettings enabled skills", () => {
  it("defaults legacy settings to no per-turn skill tax", () => {
    expect(decodeServerSettings({}).skills).toEqual({
      enabledByDefault: [],
      enabledByThread: {},
    });
  });

  it("trims names and accepts a whole-list patch", () => {
    expect(
      decodeServerSettingsPatch({
        skills: { enabledByDefault: ["  focus-mode  ", "security-review"] },
      }).skills,
    ).toEqual({ enabledByDefault: ["focus-mode", "security-review"] });
  });

  it("rejects empty, oversized, and excessive enabled-skill lists", () => {
    expect(() => decodeServerSettingsPatch({ skills: { enabledByDefault: ["   "] } })).toThrow();
    expect(() =>
      decodeServerSettingsPatch({ skills: { enabledByDefault: ["x".repeat(129)] } }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        skills: { enabledByDefault: Array.from({ length: 13 }, (_, index) => `skill-${index}`) },
      }),
    ).toThrow();
  });

  it("trims and bounds chat-specific skill selections", () => {
    expect(
      decodeServerSettingsPatch({
        skills: { enabledByThread: { "thread-one": ["  chat-skill  "] } },
      }).skills,
    ).toEqual({ enabledByThread: { "thread-one": ["chat-skill"] } });
    expect(() =>
      decodeServerSettingsPatch({
        skills: {
          enabledByThread: {
            "thread-one": Array.from({ length: 13 }, (_, index) => `skill-${index}`),
          },
        },
      }),
    ).toThrow();
  });

  it("decodes atomic global and chat skill updates", () => {
    expect(
      decodeServerSettingsPatch({
        skills: {
          setEnabledByDefault: { name: " review ", enabled: true },
          setEnabledForThread: { threadId: "thread-one", names: [" chat-skill "] },
        },
      }).skills,
    ).toEqual({
      setEnabledByDefault: { name: "review", enabled: true },
      setEnabledForThread: { threadId: "thread-one", names: ["chat-skill"] },
    });
  });

  it("decodes one atomic chat skill toggle", () => {
    expect(
      decodeServerSettingsPatch({
        skills: {
          setEnabledForThreadSkill: {
            threadId: "thread-one",
            name: " review ",
            enabled: true,
          },
        },
      }).skills,
    ).toEqual({
      setEnabledForThreadSkill: {
        threadId: "thread-one",
        name: "review",
        enabled: true,
      },
    });
  });

  it("rejects an unbounded number of chats with session skills", () => {
    expect(() =>
      decodeServerSettingsPatch({
        skills: {
          enabledByThread: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`thread-${index}`, ["skill"]]),
          ),
        },
      }),
    ).toThrow();
  });
});

describe("ServerSettings dev pipelines", () => {
  const pipeline = {
    name: "fix-and-review",
    pipelinePrompt: "PLAN !codex:gpt-5.6-sol",
    promptFiles: [{ name: "rules.md", content: "Keep the patch minimal." }],
  };

  it("defaults legacy settings to an empty environment-scoped pipeline list", () => {
    expect(decodeServerSettings({}).dev).toEqual({ scenarios: [], activeScenario: "" });
  });

  it("round-trips pipeline prompts and files through full settings decode", () => {
    expect(
      decodeServerSettings({
        dev: { scenarios: [pipeline], activeScenario: "fix-and-review" },
      }).dev,
    ).toEqual({ scenarios: [pipeline], activeScenario: "fix-and-review" });
  });

  it("accepts whole-list patches and rejects invalid scenario names", () => {
    expect(
      decodeServerSettingsPatch({
        dev: { scenarios: [pipeline], activeScenario: "fix-and-review" },
      }).dev,
    ).toEqual({ scenarios: [pipeline], activeScenario: "fix-and-review" });
    expect(() =>
      decodeServerSettingsPatch({
        dev: { scenarios: [{ ...pipeline, name: "Not Valid" }] },
      }),
    ).toThrow();
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
