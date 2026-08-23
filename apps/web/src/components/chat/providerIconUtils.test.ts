import { ProviderDriverKind } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AgyIcon, JunieIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icons", () => {
  it("uses distinct provider icons for Agy and Junie", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("agy")]).toBe(AgyIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("junie")]).toBe(JunieIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("agy")]).not.toBe(
      PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("junie")],
    );
  });
});
