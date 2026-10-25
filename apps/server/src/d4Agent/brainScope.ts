import { sha256Hex } from "@d4research/shared/hash";
import { ProjectId, type D4AgentSettings, type D4BrainContext } from "@d4research/contracts";

export function projectInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  return context === "Global" || settings.projectContexts[ProjectId.make(projectId)] === context;
}

export function projectContentInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  const mapped = settings.projectContexts[ProjectId.make(projectId)];
  return context === "Global" ? mapped === undefined : mapped === context;
}

// Only membership changes affecting the bound context retire its session.
export function contextScopeHash(context: D4BrainContext, settings: D4AgentSettings): string {
  return sha256Hex(
    JSON.stringify([
      context,
      settings.brainVaultPath,
      Object.entries(settings.projectContexts)
        .filter(([, mapped]) => context === "Global" || mapped === context)
        .map(([id]) => id)
        .sort(),
    ]),
  );
}
