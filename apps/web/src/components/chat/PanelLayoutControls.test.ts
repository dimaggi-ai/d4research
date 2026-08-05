import { describe, expect, it } from "vite-plus/test";

import { getLocalToolsMenuItems } from "./PanelLayoutControls";

describe("local tools menu", () => {
  it("merges Monitor and Files into one stable menu", () => {
    expect(getLocalToolsMenuItems({ systemMonitorOpen: false, filesAvailable: true })).toEqual([
      { id: "monitor", label: "Monitor", disabled: false },
      { id: "files", label: "Files", disabled: false },
    ]);
  });

  it("shows the reverse monitor action and disables unavailable files", () => {
    expect(getLocalToolsMenuItems({ systemMonitorOpen: true, filesAvailable: false })).toEqual([
      { id: "monitor", label: "Close Monitor", disabled: false },
      { id: "files", label: "Files", disabled: true },
    ]);
  });
});
