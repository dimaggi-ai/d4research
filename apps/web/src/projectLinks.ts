import { getClientSettings, persistClientSettingsPatch } from "./hooks/useSettings";
import { selectProjectGroupingSettings, withProjectLink } from "./logicalProject";
import type { Project } from "./types";

type LinkableProject = Pick<
  Project,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

/**
 * Shows checkouts under another logical project on this device, or under
 * their own again when `logicalProjectKey` is null. Reads the settings at call
 * time so a link made right after a project was added is not lost.
 */
export function linkProjects(
  projects: ReadonlyArray<LinkableProject>,
  logicalProjectKey: string | null,
): Promise<void> {
  let settings = selectProjectGroupingSettings(getClientSettings());
  for (const project of projects) {
    settings = {
      ...settings,
      sidebarProjectLinks: withProjectLink(project, logicalProjectKey, settings),
    };
  }
  return persistClientSettingsPatch({ sidebarProjectLinks: settings.sidebarProjectLinks ?? {} });
}
