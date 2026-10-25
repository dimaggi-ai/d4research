import { sha256Hex } from "@d4research/shared/hash";
import { ProjectId, type D4AgentSettings, type D4BrainContext } from "@d4research/contracts";

export function projectInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  return context === "Global" || settings.projectContexts[ProjectId.make(projectId)] === context;
}

// A mapping or vault-root change invalidates sessions that already saw the old scope.
export function contextScopeHash(context: D4BrainContext, settings: D4AgentSettings): string {
  return sha256Hex(
    JSON.stringify([
      context,
      settings.brainVaultPath,
      Object.entries(settings.projectContexts).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}
