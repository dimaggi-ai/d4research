import { describe, expect, it, vi } from "vite-plus/test";
import type { ServerProviderModel } from "@d4research/contracts";

import { deriveProviderModelsForDisplay, ProviderDetailsButton } from "./ProviderInstanceCard";
import { PROVIDER_CLIENT_DEFINITIONS } from "./providerDriverMeta";

describe("provider driver registry", () => {
  it("registers each provider driver exactly once", () => {
    const drivers = PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value);
    expect(drivers.filter((driver) => driver === "agy")).toHaveLength(1);
    expect(new Set(drivers).size).toBe(drivers.length);
  });
});

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("prefers the entry's name and capabilities over the stale live custom row", () => {
    const liveCapabilities = { optionDescriptors: [] };
    const customCapabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    };
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      { slug: "bare", name: "bare", isCustom: true, capabilities: liveCapabilities },
      { slug: "named", name: "named", isCustom: true, capabilities: liveCapabilities },
    ];

    const display = deriveProviderModelsForDisplay({
      liveModels,
      customModels: [
        { slug: "bare", name: "bare", capabilities: null },
        { slug: "named", name: "My Model", capabilities: customCapabilities },
      ],
    });

    // A bare entry keeps the driver default the server filled in.
    expect(display[0]).toEqual({
      slug: "bare",
      name: "bare",
      isCustom: true,
      capabilities: liveCapabilities,
    });
    expect(display[1]).toEqual({
      slug: "named",
      name: "My Model",
      isCustom: true,
      capabilities: customCapabilities,
    });
  });
});

describe("ProviderDetailsButton", () => {
  it.each([
    { isExpanded: false, next: true, label: "Show Codex details" },
    { isExpanded: true, next: false, label: "Hide Codex details" },
  ])("toggles provider details from $isExpanded", ({ isExpanded, next, label }) => {
    const onExpandedChange = vi.fn();
    const button = ProviderDetailsButton({
      instanceId: "codex" as never,
      displayName: "Codex",
      isExpanded,
      onExpandedChange,
    });

    expect(button.props["aria-expanded"]).toBe(isExpanded);
    expect(button.props["aria-label"]).toBe(label);
    expect(button.props.type).toBe("button");
    button.props.onClick();
    expect(onExpandedChange).toHaveBeenCalledWith(next);
  });
});
