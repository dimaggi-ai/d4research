import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ModelSelection, type ServerConfig } from "@d4research/contracts";

import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("carries configured ACP identity into model and provider catalogs", () => {
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg";
    const config = {
      providers: [
        {
          instanceId: "acpRegistry_antigravity",
          driver: "acpRegistry",
          displayName: "Antigravity",
          iconUrl,
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "default",
              name: "Default",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [group] = groupByProvider(buildModelOptions(config, null));

    expect(group).toMatchObject({
      providerKey: "acpRegistry_antigravity",
      providerLabel: "Antigravity",
      models: [
        {
          providerDriver: "acpRegistry",
          providerIconUrl: iconUrl,
        },
      ],
    });
  });

  it("distinguishes same-name OpenCode models without changing their routing", () => {
    const sources = [
      { id: "anthropic", label: "Anthropic" },
      { id: "github-copilot", label: "GitHub Copilot" },
      { id: "opencode", label: "OpenCode Zen" },
    ];
    const config = {
      providers: [
        {
          instanceId: "opencode_work",
          driver: "opencode",
          displayName: "OpenCode Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: sources.map((source) => ({
            slug: `${source.id}/claude-fable-5`,
            name: "Claude Fable 5",
            subProvider: source.label,
            isCustom: false,
            capabilities: null,
          })),
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("opencode_work"),
      model: "github-copilot/claude-fable-5",
    };

    const options = buildModelOptions(config, selection);

    expect(options).toMatchObject(
      sources.map((source) => ({
        key: `opencode_work:${source.id}/claude-fable-5`,
        label: "Claude Fable 5",
        subtitle: source.label,
        providerLabel: "OpenCode Work",
        selection: {
          instanceId: "opencode_work",
          model: `${source.id}/claude-fable-5`,
        },
      })),
    );
    expect(groupByProvider(options)).toEqual([
      { providerKey: "opencode_work", providerLabel: "OpenCode Work", models: options },
    ]);
  });

  it("does not materialize catalog defaults for missing stored options", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toBeUndefined();

    const [emptyOption] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [],
    });
    expect(emptyOption?.selection).toEqual(option?.selection);

    const [explicitOption] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "serviceTier", value: "priority" }],
    });
    expect(explicitOption?.selection.options).toEqual([{ id: "serviceTier", value: "priority" }]);
  });

  it("limits existing threads to their provider while new tasks keep every provider", () => {
    const providers = ["codex", "claudeAgent"].map((instanceId) => ({
      instanceId,
      driver: instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "test", name: instanceId, capabilities: null }],
    }));
    const config = { providers } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };

    expect(buildModelOptions(config, selection).map((option) => option.providerKey)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(buildModelOptions(config, selection, selection.instanceId)).toEqual(
      buildModelOptions(config, selection).filter((option) => option.providerKey === "codex"),
    );
  });

  it.each(["disabled", "unavailable", "missing"] as const)(
    "retains the selected %s provider's fallback in a filtered catalog",
    (state) => {
      const selection = {
        instanceId: ProviderInstanceId.make("google_work"),
        model: "saved-model",
        options: [{ id: "native-option", value: "saved-choice" }],
      };
      const provider = {
        instanceId: selection.instanceId,
        driver: "antigravity",
        displayName: "Google Work",
        enabled: state !== "disabled",
        installed: true,
        availability: state === "unavailable" ? "unavailable" : "available",
        auth: { status: "authenticated" },
        models: [{ slug: selection.model, name: "Saved model", capabilities: null }],
      };
      const config = {
        providers: state === "missing" ? [] : [provider],
        settings: { providerInstances: { google_work: { driver: "antigravity" } } },
      } as unknown as ServerConfig;
      const options = buildModelOptions(config, selection, selection.instanceId);
      expect(options).toEqual(buildModelOptions(config, selection));
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection, isUnavailable: true });
    },
  );

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          status: "disabled",
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("hides cached models when the server readiness contract cannot start", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          readiness: {
            installation: "ready",
            authentication: "ready",
            reachability: "unknown",
            modelCatalog: "unknown",
            canStart: false,
            checkedAt: "2026-08-11T20:00:00.000Z",
            remediation: "Refresh provider status.",
          },
          models: [{ slug: "cached", name: "Cached", isCustom: false, capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null)).toEqual([]);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});
