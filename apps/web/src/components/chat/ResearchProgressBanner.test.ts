import { describe, expect, it } from "vite-plus/test";

import { deriveActiveStageSuggestion, summarizeResearchProgress } from "./ResearchProgressBanner";

describe("summarizeResearchProgress", () => {
  it("reports the in-progress stage", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Gather primary evidence", status: "inProgress" },
        { step: "Synthesize the answer", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 3, current: "Gather primary evidence" });
  });

  it("falls back to the next unfinished stage between stages", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Challenge findings", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 2, current: "Challenge findings" });
  });

  it("reports no current stage once everything is complete", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Synthesize the answer", status: "completed" },
      ]),
    ).toEqual({ completed: 2, total: 2, current: null });
  });
});

describe("deriveActiveStageSuggestion", () => {
  const stages = [
    { title: "Scope the question" },
    {
      title: "Survey literature",
      suggestedInstanceId: "junie",
      suggestedModel: "gemini-3.1-pro",
    },
  ];

  it("suggests the active stage's provider when it differs from the current one", () => {
    expect(
      deriveActiveStageSuggestion({
        steps: [
          { step: "Scope the question", status: "completed" },
          { step: "Survey literature", status: "inProgress" },
        ],
        stages,
        current: { instanceId: "claude", model: "sonnet" },
      }),
    ).toEqual({ instanceId: "junie", model: "gemini-3.1-pro" });
  });

  it("matches stage titles case-insensitively against free-text plan steps", () => {
    expect(
      deriveActiveStageSuggestion({
        steps: [{ step: "  survey LITERATURE ", status: "inProgress" }],
        stages,
        current: { instanceId: "claude", model: "sonnet" },
      }),
    ).toEqual({ instanceId: "junie", model: "gemini-3.1-pro" });
  });

  it("stays quiet when the suggestion is already active", () => {
    expect(
      deriveActiveStageSuggestion({
        steps: [{ step: "Survey literature", status: "inProgress" }],
        stages,
        current: { instanceId: "junie", model: "gemini-3.1-pro" },
      }),
    ).toBeNull();
  });

  it("stays quiet when the active stage has no suggestion or nothing is active", () => {
    expect(
      deriveActiveStageSuggestion({
        steps: [{ step: "Scope the question", status: "inProgress" }],
        stages,
        current: { instanceId: "claude", model: "sonnet" },
      }),
    ).toBeNull();
    expect(
      deriveActiveStageSuggestion({
        steps: [{ step: "Survey literature", status: "completed" }],
        stages,
        current: { instanceId: "claude", model: "sonnet" },
      }),
    ).toBeNull();
  });
});
