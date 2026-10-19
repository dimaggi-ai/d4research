import { ProviderDriverKind } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AgyIcon, JunieIcon } from "../Icons";
import {
  PROVIDER_ICON_BY_PROVIDER,
  getDisplayModelName,
  getProviderRowLabel,
} from "./providerIconUtils";

describe("provider icons", () => {
  it("uses distinct provider icons for Agy and Junie", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("agy")]).toBe(AgyIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("junie")]).toBe(JunieIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("agy")]).not.toBe(
      PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("junie")],
    );
  });
});
describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});
