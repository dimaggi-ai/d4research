import { describe, expect, it } from "vite-plus/test";
import { applyModelDisplayNames, setModelDisplayName } from "./providerAppearance.ts";

describe("provider appearance", () => {
  it("changes both labels without changing routing or other model metadata", () => {
    const models = [{ slug: "real-id", name: "Original", shortName: "Short", isDefault: true }];
    expect(applyModelDisplayNames(models, { "real-id": "My model" })).toEqual([
      { slug: "real-id", name: "My model", shortName: "My model", isDefault: true },
    ]);
    expect(models[0]?.name).toBe("Original");
    expect(applyModelDisplayNames(models, {})[0]).toBe(models[0]);
  });

  it("clears one name without losing icons or other model names", () => {
    const appearance = {
      icon: "claudeAgent",
      badgeIcon: "cursor",
      modelNames: { a: "Alpha", b: "Beta" },
    };
    expect(setModelDisplayName(appearance, "a", "  ")).toEqual({
      icon: "claudeAgent",
      badgeIcon: "cursor",
      modelNames: { b: "Beta" },
    });
    expect(setModelDisplayName(appearance, "a", " New ").modelNames.a).toBe("New");
    expect(appearance.modelNames.a).toBe("Alpha");
  });
});
