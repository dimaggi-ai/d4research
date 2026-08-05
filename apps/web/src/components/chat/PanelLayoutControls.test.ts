import { describe, expect, it } from "vite-plus/test";

import { getLocalToolsMenuItems } from "./PanelLayoutControls";

describe("local tools menu", () => {
  it("merges Monitor and Files into one stable menu", () => {
    expect(
      getLocalToolsMenuItems({
        systemMonitorOpen: false,
        filesAvailable: true,
        tasksOpen: false,
        tasksLabel: "Tasks",
      }),
    ).toEqual([
      { id: "monitor", label: "Monitor", disabled: false },
      { id: "files", label: "Files", disabled: false },
      { id: "tasks", label: "Tasks", disabled: false },
    ]);
  });

  it("shows the reverse monitor action and disables unavailable files", () => {
    expect(
      getLocalToolsMenuItems({
        systemMonitorOpen: true,
        filesAvailable: false,
        tasksOpen: true,
        tasksLabel: "Plan",
      }),
    ).toEqual([
      { id: "monitor", label: "Close Monitor", disabled: false },
      { id: "files", label: "Files", disabled: true },
      { id: "tasks", label: "Close Plan", disabled: false },
    ]);
  });
});
