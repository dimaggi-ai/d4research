import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveJunieModelSelection } from "./JunieAdapter.ts";

describe("resolveJunieModelSelection", () => {
  it("does not send the synthetic default model to Junie", () => {
    expect(
      resolveJunieModelSelection({
        instanceId: ProviderInstanceId.make("junie"),
        model: "default",
      }),
    ).toBeUndefined();
  });

  it("preserves a real model advertised by Junie", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("junie"),
      model: "anthropic-claude-sonnet",
    };
    expect(resolveJunieModelSelection(selection)).toEqual(selection);
  });
});
