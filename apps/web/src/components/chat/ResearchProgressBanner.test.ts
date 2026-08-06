import { describe, expect, it } from "vite-plus/test";

import { summarizeResearchProgress } from "./ResearchProgressBanner";

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
