import type { EnvironmentId, PeerProject, ProjectId } from "@d4research/contracts";

import { getClientSettings } from "./hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "./logicalProject";
import { readProjects } from "./state/entities";

/**
 * The projects of one environment as an agent on `source` should see them:
 * `sameProject` follows this device's grouping, hand-made links included.
 */
export function peerProjects(
  environmentId: EnvironmentId,
  source: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId | null },
): ReadonlyArray<PeerProject> {
  const settings = selectProjectGroupingSettings(getClientSettings());
  const projects = readProjects().filter((project) => project.isScratch !== true);
  const own = projects.find(
    (project) => project.environmentId === source.environmentId && project.id === source.projectId,
  );
  const ownKey = own === undefined ? null : deriveLogicalProjectKeyFromSettings(own, settings);
  return projects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      sameProject: deriveLogicalProjectKeyFromSettings(project, settings) === ownKey,
    }));
}
