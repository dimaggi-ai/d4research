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
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
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
