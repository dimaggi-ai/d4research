import { persistClientSettingsUpdate } from "./hooks/useSettings";
import { selectProjectGroupingSettings, withProjectLink } from "./logicalProject";
import type { Project } from "./types";

type LinkableProject = Pick<
  Project,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

// Apply links after hydration and serialize concurrent edits to the local map.
export async function linkProjects(
  projects: ReadonlyArray<LinkableProject>,
  logicalProjectKey: string | null,
): Promise<void> {
  await persistClientSettingsUpdate((current) => {
    let settings = selectProjectGroupingSettings(current);
    for (const project of projects) {
      settings = Object.assign({}, settings, {
        sidebarProjectLinks: withProjectLink(project, logicalProjectKey, settings),
      });
    }
    return { ...current, sidebarProjectLinks: settings.sidebarProjectLinks ?? {} };
  });
}
