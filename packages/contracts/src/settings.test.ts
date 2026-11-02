import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "./providerInstance.ts";
import {
  DEFAULT_SETTLED_THREAD_RETENTION_DAYS,
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeProviderInstanceEnvironment = Schema.encodeSync(ProviderInstanceEnvironment);
const decodeProviderInstanceEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);
// The environment variable shape builds released before secret references decode.
const decodeStringOnlyEnvironment = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
  ),
);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps upstream's cleanup rules off, and this fork's settle rules on", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeOnSettle: true,
      settledThreadAfterDays: DEFAULT_SETTLED_THREAD_RETENTION_DAYS,
      worktreeKeepWhen: "any-local-files",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("keeps stored project rules without the settle rule", () => {
    const stored = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 3,
          worktreeOnMerge: true,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    }).worktreeCleanup;
    expect(stored?.mode === "custom" ? stored.rules.worktreeOnSettle : null).toBe(false);
  });

  it("accepts eight-day retention and disabling one rule without resetting others", () => {
    expect(decodeServerSettingsPatch({ storageCleanup: { worktreeAfterDays: 8 } })).toEqual({
      storageCleanup: { worktreeAfterDays: 8 },
    });
    expect(decodeServerSettingsPatch({ storageCleanup: { worktreeAfterDays: null } })).toEqual({
      storageCleanup: { worktreeAfterDays: null },
    });
    expect(decodeServerSettingsPatch({ storageCleanup: { worktreeSettledAfterDays: 0 } })).toEqual({
      storageCleanup: { worktreeSettledAfterDays: 0 },
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "any-local-files" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "any-local-files" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });

  it("ignores an invalid model filter without dropping the other settings", () => {
    const valid = { include: [{ provider: "newer-provider", model: "orbit-1" }] };
    expect(decodeServerSettings({ usageModelFilter: valid }).usageModelFilter).toEqual(valid);
    const settings = decodeServerSettings({
      usageModelFilter: { exclude: [{ model: "" }] },
      usageModelAliases: { "drift-9": "orbit-1" },
    });
    expect(settings.usageModelFilter).toBeUndefined();
    expect(settings.usageModelAliases).toEqual({ "drift-9": "orbit-1" });
  });
});

describe("ServerSettings secret providers", () => {
  const onePassword = (account: string) => ({
    kind: "one_password",
    label: "Personal",
    config: { account },
  });

  it("keeps an unknown kind or a longer label from invalidating the rest of the settings", () => {
    const openbao = { kind: "openbao", label: "V".repeat(65), config: { address: "https://x" } };
    const decoded = decodeServerSettings({
      worktreesDirectory: "/work",
      secretProviders: { vault: openbao, personal: onePassword("my.1password.com") },
    });
    expect(decoded.worktreesDirectory).toBe("/work");
    expect(encodeServerSettings(decoded).secretProviders).toEqual({
      vault: openbao,
      personal: onePassword("my.1password.com"),
    });
  });

  it("accepts slug ids and null removals but no id that is not a slug", () => {
    expect(
      decodeServerSettingsPatch({
        secretProviders: { "1password": onePassword("my.1password.com"), work: null },
      }).secretProviders,
    ).toEqual({ "1password": onePassword("my.1password.com"), work: null });
    for (const id of ["", "My Vault", "a/b", "-vault"]) {
      expect(() =>
        decodeServerSettingsPatch({ secretProviders: { [id]: onePassword("my.1password.com") } }),
      ).toThrow();
    }
    expect(() =>
      decodeServerSettingsPatch({
        secretProviders: { work: { ...onePassword("my.1password.com"), label: "V".repeat(65) } },
      }),
    ).toThrow();
  });

  it("stores a provider environment secret reference in a layout older builds still decode", () => {
    const providerInstances = (secret: unknown) => ({
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", sensitive: true, value: "", secret },
          { name: "BASE_URL", value: "https://example.test" },
        ],
      },
    });
    const secret = { provider: "personal", reference: "op://Private/OpenAI/credential" };
    const environment = decodeServerSettings({ providerInstances: providerInstances(secret) })
      .providerInstances[ProviderInstanceId.make("codex")]?.environment;
    expect(environment).toEqual([
      { name: "OPENAI_API_KEY", value: secret, sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    const encoded = encodeProviderInstanceEnvironment(environment ?? []);
    expect(encoded).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true, secret },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);
    expect(decodeProviderInstanceEnvironment(encoded)).toEqual(environment);
    expect(decodeStringOnlyEnvironment(encoded)).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    for (const invalid of [
      { provider: "My Vault", reference: "op://a/b/c" },
      { provider: "personal", reference: " " },
      { provider: "personal", reference: "op://Private/OpenAI\n/credential" },
      { provider: "personal", reference: "x".repeat(1025) },
    ]) {
      expect(() =>
        decodeServerSettings({ providerInstances: providerInstances(invalid) }),
      ).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("ServerSettings handoff compression", () => {
  it("defaults local compression to the resident bonsai2 model", () => {
    const compression = decodeServerSettings({}).handoff.contextCompression;
    expect(compression.mode).toBe("bounded");
    expect(compression.secondaryJudgeModel).toBe("");
    expect(compression.localModel).toBe("bonsai2-27b:latest");
    expect(compression.maxInputCharacters).toBe(24_000);
    expect(compression.maxOutputCharacters).toBe(3_000);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings dashboard layout", () => {
  it("keeps old settings on the status board and round-trips the project lanes choice", () => {
    expect(decodeClientSettings({}).dashboardLayout).toBe("board");
    const settings = decodeClientSettings({ dashboardLayout: "projects" });
    expect(encodeClientSettings(settings).dashboardLayout).toBe("projects");
    expect(decodeClientSettingsPatch({ dashboardLayout: "projects" }).dashboardLayout).toBe(
      "projects",
    );
    expect(() => decodeClientSettingsPatch({ dashboardLayout: "inbox" })).toThrow();
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });

  it("rejects legacy booleans at the patch boundary", () => {
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ClientSettings browser recording frame rate", () => {
  it("defaults to 30 fps", () => {
    expect(decodeClientSettings({}).browserRecordingFrameRate).toBe(30);
  });

  it.each([30, 60])("accepts a supported frame rate: %s", (frameRate) => {
    expect(
      decodeClientSettings({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
    expect(
      decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
  });

  it.each([24, 59, 120])("rejects an unsupported frame rate: %s", (frameRate) => {
    expect(() => decodeClientSettings({ browserRecordingFrameRate: frameRate })).toThrow();
    expect(() => decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate })).toThrow();
  });
});

describe("ClientSettings recording input overlays", () => {
  it("defaults both overlays off and accepts independent opt-ins", () => {
    const settings = decodeClientSettings({});
    expect(settings.browserRecordingShowKeyPresses).toBe(false);
    expect(settings.browserRecordingShowMousePresses).toBe(false);
    expect(
      decodeClientSettingsPatch({
        browserRecordingShowKeyPresses: true,
        browserRecordingShowMousePresses: false,
      }),
    ).toMatchObject({
      browserRecordingShowKeyPresses: true,
      browserRecordingShowMousePresses: false,
    });
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

  it.each([40, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
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
  it("defaults to the current sidebar", () => {
    expect(decodeClientSettings({}).legacySidebarEnabled).toBe(false);
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

  it("drops the retired compact sidebar keys for users who opted in", () => {
    const stored = { compactSidebarEnabled: true, sidebarCompactThreadRows: true };
    const decoded = decodeClientSettings(stored);
    expect(decoded).not.toHaveProperty("compactSidebarEnabled");
    expect(decoded).not.toHaveProperty("sidebarCompactThreadRows");
    expect(decodeClientSettingsPatch(stored)).toEqual({});
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });
});

describe("ClientSettings context window meter", () => {
  it("defaults off and preserves an explicit legacy opt-in", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings send shortcut", () => {
  it("defaults to Enter and validates the supported choices", () => {
    expect(decodeClientSettings({}).sendShortcut).toBe("enter");
    for (const sendShortcut of ["enter", "mod-enter-multiline", "mod-enter"]) {
      expect(decodeClientSettings({ sendShortcut }).sendShortcut).toBe(sendShortcut);
      expect(decodeClientSettingsPatch({ sendShortcut }).sendShortcut).toBe(sendShortcut);
    }
    expect(() => decodeClientSettingsPatch({ sendShortcut: "invalid" })).toThrow();
  });
});

describe("ClientSettings follow-up behavior", () => {
  it("defaults to wait and accepts every behavior", () => {
    expect(decodeClientSettings({}).followUpBehavior).toBe("wait");
    for (const followUpBehavior of ["wait", "queue", "steer"]) {
      expect(decodeClientSettings({ followUpBehavior }).followUpBehavior).toBe(followUpBehavior);
      expect(decodeClientSettingsPatch({ followUpBehavior }).followUpBehavior).toBe(
        followUpBehavior,
      );
    }
    expect(() => decodeClientSettingsPatch({ followUpBehavior: "invalid" })).toThrow();
  });
});

describe("ServerSettings thread settlement", () => {
  it("preserves legacy thresholds but defaults the fork policy to never settle automatically", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
    expect(settings.sidebarAutoSettleMode).toBe("never");
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings pipeline target policy", () => {
  it("defaults to explicit labeled fallbacks and accepts Exact mode", () => {
    expect(decodeServerSettings({}).pipelineTargetPolicy).toBe("labeled-fallback");
    expect(decodeServerSettingsPatch({ pipelineTargetPolicy: "exact" })).toEqual({
      pipelineTargetPolicy: "exact",
    });
  });

  it("rejects untracked or equivalence-claiming substitution modes", () => {
    expect(() => decodeServerSettingsPatch({ pipelineTargetPolicy: "equivalent-model" })).toThrow();
  });
});

describe("ClientSettings pull request merge methods", () => {
  it("defaults to no project overrides and accepts supported methods", () => {
    expect(decodeClientSettings({}).pullRequestMergeMethodOverrides).toEqual({});
    expect(
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "squash" },
      }).pullRequestMergeMethodOverrides,
    ).toEqual({ project: "squash" });
  });

  it("rejects unsupported project merge methods", () => {
    expect(() =>
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "fast-forward" },
      }),
    ).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
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

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const muse = ProviderDriverKind.make("muse");
    expect(resolveProviderInstanceEnabled({ driver: muse, config: {} })).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: muse, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
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

  it("accepts atomic scenario upserts and removals", () => {
    expect(
      decodeServerSettingsPatch({
        dev: { upsertScenario: pipeline },
        research: { removeScenario: "starter" },
      }),
    ).toMatchObject({
      dev: { upsertScenario: pipeline },
      research: { removeScenario: "starter" },
    });
    expect(() => decodeServerSettingsPatch({ dev: { removeScenario: "Not Valid" } })).toThrow();
  });
});

describe("ServerSettings Cursor legacy settings", () => {
  it("preserves V1 Cursor CLI settings when reading and writing shared settings", () => {
    const decoded = decodeServerSettings({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(encodeServerSettings(decoded).providers?.cursor).toMatchObject({
      binaryPath: "cursor-agent",
      apiEndpoint: "http://127.0.0.1:3774",
    });
  });

  it("ignores obsolete Cursor CLI settings in patches", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(patch.providers?.cursor?.enabled).toBe(true);
    expect(patch.providers?.cursor).not.toHaveProperty("binaryPath");
    expect(patch.providers?.cursor).not.toHaveProperty("apiEndpoint");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ClientSettings accent colour", () => {
  it("defaults to the theme's own accent", () => {
    expect(decodeClientSettings({}).accentColor).toBeNull();
  });

  it("accepts short and long hex", () => {
    expect(decodeClientSettings({ accentColor: "#f0a" }).accentColor).toBe("#f0a");
    expect(decodeClientSettings({ accentColor: "#3b6ef0" }).accentColor).toBe("#3b6ef0");
  });

  // Rejected the same way an out-of-range glass opacity is, and the runtime parses the value again
  // before it reaches the document, so neither layer can put arbitrary CSS in a custom property.
  it("refuses anything that is not hex", () => {
    for (const value of ["red", "var(--x)", "#12345", "url(evil)"]) {
      expect(() => decodeClientSettings({ accentColor: value })).toThrow();
    }
  });
});

describe("ServerSettings environment icon compatibility", () => {
  it("keeps a kind this build knows", () => {
    expect(decodeServerSettings({ environmentIcon: "mac-mini" }).environmentIcon).toBe("mac-mini");
    expect(decodeServerSettings({ environmentIcon: "linux" }).environmentIcon).toBe("linux");
  });

  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("branch naming settings", () => {
  it("defaults existing settings to the t3 static prefix", () => {
    expect(decodeServerSettings({})).toMatchObject({
      branchNamingMode: "static",
      branchNamePrefix: "t3",
      branchNameInstructions: "",
    });
  });
  it.each(["static", "semantic", "custom"])(
    "round-trips %s and project overrides",
    (branchNamingMode) => {
      const naming = {
        branchNamingMode,
        branchNamePrefix: "team/",
        branchNameInstructions: "Include the issue ID.",
      };
      const input = { ...naming, projectSettingsOverrides: { project: naming } };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );
});

it.each(["bounded", "direct", "smart"])(
  "accepts automatic handoff mode %s at the settings boundary",
  (mode) => {
    expect(
      decodeServerSettingsPatch({ handoff: { contextCompression: { mode } } }).handoff
        ?.contextCompression?.mode,
    ).toBe(mode);
    expect(
      decodeServerSettings({ handoff: { contextCompression: { mode } } }).handoff.contextCompression
        .mode,
    ).toBe(mode);
  },
);
describe("ServerSettings.removeAgentCreditsOnMerge", () => {
  it("keeps agent credits by default and accepts opt-in patches", () => {
    expect(decodeServerSettings({}).removeAgentCreditsOnMerge).toBe(false);
    expect(
      decodeServerSettingsPatch({ removeAgentCreditsOnMerge: true }).removeAgentCreditsOnMerge,
    ).toBe(true);
    expect(
      decodeServerSettings({
        projectSettingsOverrides: { project: { removeAgentCreditsOnMerge: true } },
      }).projectSettingsOverrides["project" as ProjectId]?.removeAgentCreditsOnMerge,
    ).toBe(true);
  });
});

describe("ServerSettings project overrides across versions", () => {
  it("sends back an override key from a newer server when an older client edits the entry", () => {
    const projectId = ProjectId.make("project-a");
    // As an older client reads a newer server's settings, with one key it does not know.
    const entry = decodeServerSettings({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, addedByNewerServer: { mode: "kept" } },
      },
    }).projectSettingsOverrides[projectId];

    const sent = encodeServerSettingsPatch({
      projectSettingsOverrides: { [projectId]: { ...entry, defaultAutoPull: false } },
    });

    expect(decodeServerSettingsPatch(sent).projectSettingsOverrides?.[projectId]).toEqual({
      defaultAutoPull: false,
      addedByNewerServer: { mode: "kept" },
    });
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("provider appearance preferences", () => {
  it("defaults to no overrides and round-trips independent provider appearances", () => {
    expect(decodeClientSettings({}).providerAppearance).toEqual({});
    const providerAppearance = {
      codex: {
        icon: "claudeAgent",
        badgeIcon: "cursor",
        modelNames: { "gpt-6-astra": "Research" },
      },
      claude_work: { icon: "opencode", badgeIcon: "none", modelNames: { opus: "Writer" } },
    };
    expect(decodeClientSettingsPatch({ providerAppearance }).providerAppearance).toEqual(
      providerAppearance,
    );
    expect(
      encodeClientSettings(decodeClientSettings({ providerAppearance })).providerAppearance,
    ).toEqual(providerAppearance);
  });
});

it("keeps Meko opt-in and round-trips an explicit MCP destination", () => {
  expect(decodeServerSettings({}).handoff.memoryBackend).toBe("local");
  expect(decodeServerSettings({}).handoff.meko.url).toBe("");
  const handoff = {
    memoryBackend: "meko",
    meko: {
      url: "https://example.test/mcp",
      datapackId: "test-datapack",
      agentId: "test-agent",
      tokenEnv: "MEKO_TEST_TOKEN",
    },
  };
  const settings = decodeServerSettings({ handoff });
  expect(decodeServerSettings(encodeServerSettings(settings)).handoff).toMatchObject(handoff);
  expect(decodeServerSettingsPatch({ handoff })).toEqual({ handoff });
});

it.each([
  "http://example.test/mcp",
  "https://user:placeholder@example.test/mcp",
  "https://example.test/mcp?credential=placeholder",
  "https://example.test/mcp#fragment",
])("rejects unsafe Meko destinations: %s", (url) => {
  expect(() => decodeServerSettingsPatch({ handoff: { meko: { url } } })).toThrow();
});
it("accepts empty or loopback Meko configuration and rejects credential values as names", () => {
  for (const url of [
    "",
    "http://127.0.0.1:8090/mcp",
    "http://[::1]:8090/mcp",
    "https://example.test/mcp",
  ]) {
    expect(decodeServerSettingsPatch({ handoff: { meko: { url } } }).handoff?.meko?.url).toBe(url);
  }
  expect(() =>
    decodeServerSettingsPatch({ handoff: { meko: { tokenEnv: "not-a-variable" } } }),
  ).toThrow();
});

describe("research notes folder", () => {
  it("defaults to disabled without an environment-specific path", () => {
    expect(decodeServerSettings({}).research.notesFolder).toBe("");
  });
  it("accepts setting and clearing the environment-local folder", () => {
    expect(decodeServerSettingsPatch({ research: { notesFolder: "/notes/research" } })).toEqual({
      research: { notesFolder: "/notes/research" },
    });
    expect(decodeServerSettingsPatch({ research: { notesFolder: "" } })).toEqual({
      research: { notesFolder: "" },
    });
  });
});
