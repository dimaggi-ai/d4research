import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@d4research/contracts";
import { routineInContext, routineScheduleLabel } from "./niaRoutines.logic";

describe("routine presentation", () => {
  it("keeps work contexts separate, with Global overview access", () => {
    const project = ProjectId.make("project:synthetic");
    expect(routineInContext(project, "Global", {})).toBe(true);
    expect(routineInContext(project, "YB", {})).toBe(false);
    expect(routineInContext(project, "YB", { [project]: "YB" })).toBe(true);
    expect(routineInContext(project, "YB", { [project]: "Global" })).toBe(false);
  });
  it("preserves fixed weekdays and server-clock semantics", () => {
    expect(routineScheduleLabel({ type: "fixed_time", timeOfDay: "09:30", weekdays: [0, 6] })).toBe(
      "Sun, Sat at 09:30 (server time)",
    );
    expect(routineScheduleLabel({ type: "interval", everyMs: 90000 })).toBe("Every 90 seconds");
    expect(routineScheduleLabel({ type: "webhook", signature: null })).toBe("On webhook");
  });
});
