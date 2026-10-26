import { sha256Hex } from "@d4research/shared/hash";
import { ProjectId, type D4AgentSettings, type D4BrainContext } from "@d4research/contracts";

export function projectInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  return context === "Global" || settings.projectContexts[ProjectId.make(projectId)] === context;
}

// Thread content (messages, tails, links) is readable from Global for every project, so Global can
// monitor and explain all work. Work contexts read only their own projects. Memory retrieval is
// scoped separately and never follows this rule.
export function projectContentInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  return projectInScope(context, settings, projectId);
}

// Global is the single overview chat, so its approval cards (send, answer, start, pipelines, task
// tools) may target any project; work contexts target only their own. A card targets the project,
// it never loads that project's context memory. Continuing inside a work context still goes
// through an approved switch-context.
export function projectActionInScope(
  context: D4BrainContext,
  settings: D4AgentSettings,
  projectId: string,
): boolean {
  return projectInScope(context, settings, projectId);
}

// Only membership changes affecting the bound context retire its session.
export function contextScopeHash(context: D4BrainContext, settings: D4AgentSettings): string {
  return sha256Hex(
    JSON.stringify([
      context,
      settings.brainVaultPath,
      Object.entries(settings.overviewSources)
        .filter(([, mapped]) => mapped === context)
        .sort(([a], [b]) => a.localeCompare(b)),
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
