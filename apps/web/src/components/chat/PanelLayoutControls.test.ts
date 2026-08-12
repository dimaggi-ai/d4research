import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getLocalToolsMenuItems, PanelLayoutControls } from "./PanelLayoutControls";

describe("local tools menu", () => {
  it("keeps thread-scoped Files and Tasks in one stable menu", () => {
    expect(
      getLocalToolsMenuItems({
        filesAvailable: true,
        tasksOpen: false,
        tasksLabel: "Tasks",
      }),
    ).toEqual([
      { id: "files", label: "Files", disabled: false },
      { id: "tasks", label: "Tasks", disabled: false },
    ]);
  });

  it("shows the reverse task action and disables unavailable files", () => {
    expect(
      getLocalToolsMenuItems({
        filesAvailable: false,
        tasksOpen: true,
        tasksLabel: "Plan",
      }),
    ).toEqual([
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
        tasksOpen: false,
        tasksLabel: "Tasks",
        liveAgentCount: 2,
        onOpenFiles: () => undefined,
        onToggleTasks: () => undefined,
        onToggleTerminal: () => undefined,
        onToggleRightPanel: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Open thread tools"');
    expect(markup).toContain("Toggle right panel, 2 agents working");
  });
});
