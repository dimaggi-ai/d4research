import { useMemo } from "react";

import type { SidebarProjectSortOrder } from "@d4research/contracts";

import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { useClientSettings } from "../../hooks/useSettings";

export interface SidebarProjectGroups {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  /** Physical project keys in manual order, the shape `reorderProjects` takes. */
  readonly orderedProjectKeys: ReadonlyArray<string>;
}

/**
 * The sidebar's logical projects, in the order the sidebar shows them. Shared
 * so the project rail and the sidebar list can never disagree about what a
 * project is or where it sits. `sortOrder` overrides the user's sidebar sort,
 * which the rail pins to manual so its icons hold their place.
 */
export function useSidebarProjectGroups(options?: {
  readonly sortOrder?: SidebarProjectSortOrder;
}): SidebarProjectGroups {
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settingsSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const sidebarProjectSortOrder = options?.sortOrder ?? settingsSortOrder;
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        groupScratchProjects: true,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const orderedProjectKeys = useMemo(
    () => orderedProjects.map(getProjectOrderKey),
    [orderedProjects],
  );
  return useMemo(
    () => ({ projectGroups, orderedProjectKeys }),
    [orderedProjectKeys, projectGroups],
  );
}
