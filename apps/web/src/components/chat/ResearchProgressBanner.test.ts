import { describe, expect, it } from "vite-plus/test";

import { deriveResearchBannerSteps, summarizeResearchProgress } from "./ResearchProgressBanner";

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

describe("deriveResearchBannerSteps", () => {
  const completedPlan = [
    { step: "Old task", status: "completed" },
    { step: "Older task", status: "completed" },
  ] as const;

  it("hides a completed plan inherited from a previous turn while a new turn runs", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual([]);
  });

  it("keeps a partially finished plan from a previous turn — stages carry across handoffs", () => {
    const steps = [
      { step: "Scope the question", status: "completed" },
      { step: "Gather primary evidence", status: "inProgress" },
    ] as const;
    expect(
      deriveResearchBannerSteps({
        steps,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual(steps);
  });

  it("keeps a completed plan from the current turn — the research genuinely finished", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-2",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual(completedPlan);
  });

  it("keeps a completed plan once nothing is running", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: false,
      }),
    ).toEqual(completedPlan);
  });
});
