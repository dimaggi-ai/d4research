import { ProviderInteractionMode } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compactInteractionModeSelection } from "./CompactComposerControlsMenu";

describe("compactInteractionModeSelection", () => {
  it("clears an armed dev pipeline before entering Plan", () => {
    expect(
      compactInteractionModeSelection({
        currentMode: ProviderInteractionMode.make("default"),
        nextMode: ProviderInteractionMode.make("plan"),
      }),
    ).toEqual({ toggleMode: true, clearDevPipeline: true });
  });

  it("does not rewrite the prompt when leaving Plan for Chat", () => {
    expect(
      compactInteractionModeSelection({
        currentMode: ProviderInteractionMode.make("plan"),
        nextMode: ProviderInteractionMode.make("default"),
      }),
    ).toEqual({ toggleMode: true, clearDevPipeline: false });
  });

  it("ignores the already-selected mode", () => {
    expect(
      compactInteractionModeSelection({
        currentMode: ProviderInteractionMode.make("plan"),
        nextMode: ProviderInteractionMode.make("plan"),
      }),
    ).toBeNull();
  });
});
