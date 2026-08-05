import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { shouldRestrictModelPickerToLockedProvider } from "./modelPickerHandoff";

describe("model picker handoff", () => {
  it("shows cross-provider models in a started chat when handoff is enabled", () => {
    expect(
      shouldRestrictModelPickerToLockedProvider({
        lockedProvider: ProviderDriverKind.make("codex"),
        allowCrossProviderSelection: true,
      }),
    ).toBe(false);
  });

  it("keeps the provider lock when handoff selection is unavailable", () => {
    expect(
      shouldRestrictModelPickerToLockedProvider({
        lockedProvider: ProviderDriverKind.make("codex"),
        allowCrossProviderSelection: false,
      }),
    ).toBe(true);
  });
});
