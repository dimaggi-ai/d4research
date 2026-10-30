import { describe, expect, it } from "vite-plus/test";

import { PROJECT_SLOT_COUNT, projectSlotNumber, useProjectSlotStore } from "./projectSlotStore";

const reset = () => useProjectSlotStore.setState({ slots: {} });

describe("useProjectSlotStore", () => {
  it("assigns a project to a slot", () => {
    reset();
    useProjectSlotStore.getState().assignSlot(0, "env:alpha");
    expect(useProjectSlotStore.getState().slots).toEqual({ 0: "env:alpha" });
  });

  it("moves a project rather than letting it answer to two numbers", () => {
    reset();
    useProjectSlotStore.getState().assignSlot(0, "env:alpha");
    useProjectSlotStore.getState().assignSlot(4, "env:alpha");
    expect(useProjectSlotStore.getState().slots).toEqual({ 4: "env:alpha" });
  });

  it("replaces whatever held the slot before", () => {
    reset();
    useProjectSlotStore.getState().assignSlot(2, "env:alpha");
    useProjectSlotStore.getState().assignSlot(2, "env:beta");
    expect(useProjectSlotStore.getState().slots).toEqual({ 2: "env:beta" });
  });

  it("ignores a slot outside the numbered range", () => {
    reset();
    useProjectSlotStore.getState().assignSlot(-1, "env:alpha");
    useProjectSlotStore.getState().assignSlot(PROJECT_SLOT_COUNT, "env:alpha");
    expect(useProjectSlotStore.getState().slots).toEqual({});
  });

  it("clears a slot", () => {
    reset();
    useProjectSlotStore.getState().assignSlot(3, "env:alpha");
    useProjectSlotStore.getState().clearSlot(3);
    expect(useProjectSlotStore.getState().slots).toEqual({});
  });
});

describe("projectSlotNumber", () => {
  it("reports the one-based slot a project holds", () => {
    expect(projectSlotNumber({ 0: "env:alpha", 3: "env:beta" }, "env:beta")).toBe(4);
  });

  it("is null for a project holding none", () => {
    expect(projectSlotNumber({ 0: "env:alpha" }, "env:gamma")).toBeNull();
  });
});
