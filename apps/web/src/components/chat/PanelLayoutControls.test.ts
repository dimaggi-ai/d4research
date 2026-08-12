import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getLocalToolsMenuItems, PanelLayoutControls } from "./PanelLayoutControls";

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

  it("renders the reachable local-tools trigger and live-agent status", () => {
    const markup = renderToStaticMarkup(
      createElement(PanelLayoutControls, {
        terminalAvailable: true,
        terminalOpen: false,
        terminalShortcutLabel: null,
        rightPanelAvailable: true,
        rightPanelOpen: false,
        rightPanelShortcutLabel: null,
        systemMonitorOpen: false,
        tasksOpen: false,
        tasksLabel: "Tasks",
        liveAgentCount: 2,
        onOpenSystemMonitor: () => undefined,
        onOpenFiles: () => undefined,
        onToggleTasks: () => undefined,
        onToggleTerminal: () => undefined,
        onToggleRightPanel: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Open local tools"');
    expect(markup).toContain("Toggle right panel, 2 agents working");
  });
});
