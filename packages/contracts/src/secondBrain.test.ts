import { it, expect } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { SecondBrainSettings, ServerSettingsPatch } from "./settings.ts";
import { BrainSearchInput, BrainProposeInput } from "./secondBrain.ts";
it("decodes legacy path settings with Phase A defaults", () => {
  const config = decodeSecondBrainSettings({ path: " /tmp/brain " });
  expect(config).toEqual({
    path: "/tmp/brain",
    injection: {
      enabled: true,
      coreBudgetChars: 8000,
      retrievalBudgetChars: 6000,
      retrievalResults: 4,
    },
    capture: "off",
    writeMode: "review",
    embeddings: { enabled: false, model: "nomic-embed-text", baseUrl: "http://127.0.0.1:11434" },
    generateIndex: true,
    staleProjectDays: 30,
    reconcileIntervalSeconds: 300,
  });
});
it("decodes nested patches without inserting defaults", () =>
  expect(
    decodeServerSettingsPatch({
      secondBrain: { injection: { enabled: false }, embeddings: { model: "custom" } },
    }),
  ).toEqual({ secondBrain: { injection: { enabled: false }, embeddings: { model: "custom" } } }));
it("bounds retrieval settings and requires explicit proposal revision", () => {
  expect(() => decodeBrainSearchInput({ query: "x", limit: 51 })).toThrow();
  expect(() => decodeSecondBrainSettings({ injection: { coreBudgetChars: -1 } })).toThrow();
  expect(() =>
    decodeBrainProposeInput({
      path: "a.md",
      kind: "note",
      operation: "create",
      content: "x",
      rationale: "x",
      evidence: [],
    }),
  ).toThrow();
});

const decodeSecondBrainSettings = Schema.decodeUnknownSync(SecondBrainSettings);

const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const decodeBrainSearchInput = Schema.decodeUnknownSync(BrainSearchInput);

const decodeBrainProposeInput = Schema.decodeUnknownSync(BrainProposeInput);
