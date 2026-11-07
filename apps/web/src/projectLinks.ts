import { persistClientSettingsUpdate } from "./hooks/useSettings";
import { selectProjectGroupingSettings, withProjectLink } from "./logicalProject";
import type { Project } from "./types";

type LinkableProject = Pick<
  Project,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

/**
 * Shows checkouts under another logical project on this device, or under
 * their own again when `logicalProjectKey` is null. Queue the update so pending
 * hydration and concurrent link changes cannot overwrite one another.
 */
export async function linkProjects(
  projects: ReadonlyArray<LinkableProject>,
  logicalProjectKey: string | null,
): Promise<void> {
  await persistClientSettingsUpdate((current) => {
    let settings = selectProjectGroupingSettings(current);
    for (const project of projects) {
      settings = {
        ...settings,
        sidebarProjectLinks: withProjectLink(project, logicalProjectKey, settings),
      };
    }
    return { ...current, sidebarProjectLinks: settings.sidebarProjectLinks ?? {} };
  });
}
