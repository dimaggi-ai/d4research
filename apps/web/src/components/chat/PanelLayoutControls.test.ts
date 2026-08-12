import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("panel layout controls", () => {
  it("renders direct Files and Tasks controls with live-agent status", () => {
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

    expect(markup).toContain('aria-label="Open Files"');
    expect(markup).toContain('aria-label="Open Tasks"');
    expect(markup).toContain("Toggle right panel, 2 agents working");
  });

  it("exposes the reverse Tasks action and disables unavailable Files", () => {
    const markup = renderToStaticMarkup(
      createElement(PanelLayoutControls, {
        terminalAvailable: true,
        terminalOpen: false,
        terminalShortcutLabel: null,
        rightPanelAvailable: false,
        rightPanelOpen: false,
        rightPanelShortcutLabel: null,
        tasksOpen: true,
        tasksLabel: "Plan",
        liveAgentCount: 0,
        onOpenFiles: () => undefined,
        onToggleTasks: () => undefined,
        onToggleTerminal: () => undefined,
        onToggleRightPanel: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Open Files"');
    expect(markup).toContain('aria-label="Close Plan"');
    expect(markup).toMatch(/aria-label="Open Files"[^>]*disabled/);
  });
});
