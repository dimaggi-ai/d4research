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
      Object.entries(settings.pipelineProjects)
        .filter(([, projectId]) => projectInScope(context, settings, projectId))
        .sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
}

// A task can read only its approved project and pipeline, not the session catalog.
export function taskScopeHash(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
  pipelineId?: string,
): string {
  return sha256Hex(
    JSON.stringify([
      context,
      settings.brainVaultPath,
      projectId,
      settings.projectContexts[ProjectId.make(projectId)] ?? null,
      pipelineId ?? null,
      pipelineId === undefined ? null : (settings.pipelineProjects[pipelineId] ?? null),
    ]),
  );
}
