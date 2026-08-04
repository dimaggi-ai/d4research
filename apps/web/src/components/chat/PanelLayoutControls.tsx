import {
  Maximize2Icon,
  Minimize2Icon,
  MonitorCogIcon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  systemMonitorOpen: boolean;
  rightPanelShortcutLabel: string | null;
  onOpenSystemMonitor: () => void;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  systemMonitorOpen,
  rightPanelShortcutLabel,
  onOpenSystemMonitor,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-3 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <div className="flex items-center gap-2" data-system-controls>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 gap-1.5 px-2 [-webkit-app-region:no-drag]"
                pressed={systemMonitorOpen}
                onPressedChange={onOpenSystemMonitor}
                aria-label={systemMonitorOpen ? "Close system monitor" : "Open system monitor"}
                variant="outline"
                size="xs"
              >
                <MonitorCogIcon className="size-3.5" />
                <span className="hidden sm:inline">Monitor</span>
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">CPU, GPU, memory, disk, and processes</TooltipPopup>
        </Tooltip>
      </div>
      <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
      <div className="flex items-center gap-2" data-panel-toggle-controls>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="ghost"
                size="sm"
                disabled={!terminalAvailable}
              >
                <PanelBottomIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={rightPanelOpen}
                onPressedChange={onToggleRightPanel}
                aria-label="Toggle right panel"
                variant="ghost"
                size="sm"
                disabled={!rightPanelAvailable}
              >
                <PanelRightIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : "Right panel is unavailable"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
