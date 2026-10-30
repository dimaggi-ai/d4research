import * as Schema from "effect/Schema";
import { create } from "zustand";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const PROJECT_RAIL_VISIBLE_KEY = "t3code:sidebar:project-rail-visible";
const PROJECT_RAIL_LAYOUT_KEY = "t3code:sidebar:project-rail-layout";

export const PROJECT_RAIL_SHORT_WIDTH = 52;
export const PROJECT_RAIL_SNAP_WIDTH = 110;
export const PROJECT_RAIL_MIN_NAMED_WIDTH = 168;
export const PROJECT_RAIL_MAX_NAMED_WIDTH = 360;
const PROJECT_RAIL_DEFAULT_NAMED_WIDTH = 224;

const ProjectRailLayout = Schema.Struct({
  named: Schema.Boolean,
  width: Schema.Number,
});
export type ProjectRailLayout = typeof ProjectRailLayout.Type;

const DEFAULT_LAYOUT: ProjectRailLayout = {
  named: false,
  width: PROJECT_RAIL_DEFAULT_NAMED_WIDTH,
};

export function useProjectRailVisible() {
  return useLocalStorage(PROJECT_RAIL_VISIBLE_KEY, true, Schema.Boolean);
}

export function clampProjectRailNamedWidth(width: number): number {
  if (!Number.isFinite(width)) return PROJECT_RAIL_DEFAULT_NAMED_WIDTH;
  return Math.round(
    Math.min(PROJECT_RAIL_MAX_NAMED_WIDTH, Math.max(PROJECT_RAIL_MIN_NAMED_WIDTH, width)),
  );
}

export function useProjectRailLayout() {
  return useLocalStorage(PROJECT_RAIL_LAYOUT_KEY, DEFAULT_LAYOUT, ProjectRailLayout);
}

/** The width while the edge is being dragged, so the layout can follow it without persisting. */
export const useProjectRailDragWidth = create<{
  width: number | null;
  setWidth: (width: number | null) => void;
}>((set) => ({ width: null, setWidth: (width) => set({ width }) }));

export function resolveProjectRailWidth(layout: ProjectRailLayout, dragWidth: number | null) {
  if (dragWidth !== null) return dragWidth;
  return layout.named ? clampProjectRailNamedWidth(layout.width) : PROJECT_RAIL_SHORT_WIDTH;
}
