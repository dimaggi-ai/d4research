import { expect, it } from "vite-plus/test";

import { claudeProviderModels } from "./ClaudeProvider.ts";

it("keeps endpoint models out of the custom list that clients replace from settings", () => {
  const models = claudeProviderModels([], ["saved-model"], ["served-model", "saved-model"]);

  expect(models.map(({ slug, isCustom }) => ({ slug, isCustom }))).toEqual([
    { slug: "saved-model", isCustom: true },
    { slug: "served-model", isCustom: false },
  ]);
});
