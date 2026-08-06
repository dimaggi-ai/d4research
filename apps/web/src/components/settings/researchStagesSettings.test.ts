import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_RESEARCH_STAGES,
  RESEARCH_STAGE_MAX_COUNT,
  type ResearchStageConfig,
} from "@t3tools/contracts";

import {
  addResearchStage,
  isDefaultResearchStages,
  moveResearchStage,
  nextResearchStageId,
  removeResearchStage,
  updateResearchStage,
} from "./researchStagesSettings";

const stage = (id: string, overrides: Partial<ResearchStageConfig> = {}): ResearchStageConfig => ({
  id,
  title: `Title ${id}`,
  goal: "",
  enabled: true,
  ...overrides,
});

describe("research stage editing", () => {
  it("adds a stage with a fresh id and stops at the cap", () => {
    const added = addResearchStage([stage("scope")]);
    expect(added).toHaveLength(2);
    expect(added[1]?.id).toBe("stage-2");
    expect(added[1]?.enabled).toBe(true);

    const full = Array.from({ length: RESEARCH_STAGE_MAX_COUNT }, (_, i) => stage(`s${i}`));
    expect(addResearchStage(full)).toBe(full);
  });

  it("never reuses an existing generated id", () => {
    expect(nextResearchStageId([stage("stage-2"), stage("x")])).toBe("stage-3");
  });

  it("moves stages within bounds and ignores out-of-range moves", () => {
    const stages = [stage("a"), stage("b"), stage("c")];
    expect(moveResearchStage(stages, 2, -1).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(moveResearchStage(stages, 0, -1)).toBe(stages);
    expect(moveResearchStage(stages, 2, 1)).toBe(stages);
  });

  it("removes a stage and ignores invalid indexes", () => {
    const stages = [stage("a"), stage("b")];
    expect(removeResearchStage(stages, 0).map((s) => s.id)).toEqual(["b"]);
    expect(removeResearchStage(stages, 5)).toBe(stages);
  });

  it("sets and clears a provider suggestion without leaving undefined keys", () => {
    const stages = [stage("a")];
    const suggested = updateResearchStage(stages, 0, {
      suggestion: { instanceId: "junie", model: "gemini-3.1-pro" },
    });
    expect(suggested[0]?.suggestedInstanceId).toBe("junie");
    expect(suggested[0]?.suggestedModel).toBe("gemini-3.1-pro");

    const cleared = updateResearchStage(suggested, 0, { suggestion: null });
    expect(cleared[0] !== undefined && "suggestedInstanceId" in cleared[0]).toBe(false);
    expect(cleared[0] !== undefined && "suggestedModel" in cleared[0]).toBe(false);
  });

  it("treats parallel group zero-or-less as cleared", () => {
    const grouped = updateResearchStage([stage("a")], 0, { parallelGroup: 2 });
    expect(grouped[0]?.parallelGroup).toBe(2);
    const cleared = updateResearchStage(grouped, 0, { parallelGroup: 0 });
    expect(cleared[0] !== undefined && "parallelGroup" in cleared[0]).toBe(false);
  });

  it("preserves untouched fields when patching", () => {
    const stages = [stage("a", { goal: "keep", parallelGroup: 3 })];
    const renamed = updateResearchStage(stages, 0, { title: "Renamed" });
    expect(renamed[0]?.goal).toBe("keep");
    expect(renamed[0]?.parallelGroup).toBe(3);
  });

  it("recognizes the default stage list", () => {
    expect(isDefaultResearchStages(DEFAULT_RESEARCH_STAGES)).toBe(true);
    expect(isDefaultResearchStages(DEFAULT_RESEARCH_STAGES.slice(1))).toBe(false);
    const retitled = updateResearchStage(DEFAULT_RESEARCH_STAGES, 0, { title: "Other" });
    expect(isDefaultResearchStages(retitled)).toBe(false);
  });
});
