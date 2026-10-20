import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { getClientSettings } from "../hooks/useSettings";
import { projectJumpIndexFromCommand, resolveShortcutCommand } from "../keybindings";
import { selectProjectGroupingSettings } from "../logicalProject";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { useProjectSlotStore } from "../projectSlotStore";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
} from "../sidebarProjectGrouping";
import { readProjects } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";

export function ProjectSlotShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen())
        return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings);
      const index = projectJumpIndexFromCommand(command ?? "");
      if (index === null) return;
      const saved = useProjectSlotStore.getState().slots[index];
      if (!saved) return;
      const settings = selectProjectGroupingSettings(getClientSettings());
      // Resolve only on keypress; projection updates do not rebuild groups for this listener.
      const groups = buildSidebarProjectSnapshots({
        projects: readProjects(),
        settings,
        groupScratchProjects: true,
        primaryEnvironmentId: null,
        resolveEnvironmentLabel: () => null,
      });
      const key = resolveSidebarProjectScopeKey({
        groups,
        key: saved,
        settings,
        canClearMissingScope: true,
      });
      if (key === null) return;
      event.preventDefault();
      event.stopPropagation();
      useThreadSelectionStore.getState().clearSelection();
      useUiStateStore.getState().setSidebarProjectScopeKey(key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
  return null;
}
