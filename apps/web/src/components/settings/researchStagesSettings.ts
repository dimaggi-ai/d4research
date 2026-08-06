import {
  DEFAULT_RESEARCH_STAGES,
  RESEARCH_STAGE_MAX_COUNT,
  type ResearchStageConfig,
} from "@t3tools/contracts";

/**
 * Pure editing operations for the Deep Research stage list. The settings
 * patch replaces the whole array, so every operation returns the full next
 * list (or the input unchanged when the operation does not apply).
 */

export function nextResearchStageId(stages: ReadonlyArray<ResearchStageConfig>): string {
  const taken = new Set(stages.map((stage) => stage.id));
  let index = stages.length + 1;
  while (taken.has(`stage-${index}`)) index += 1;
  return `stage-${index}`;
}

export function addResearchStage(
  stages: ReadonlyArray<ResearchStageConfig>,
): ReadonlyArray<ResearchStageConfig> {
  if (stages.length >= RESEARCH_STAGE_MAX_COUNT) return stages;
  // Stage titles double as plan-step keys: the active-stage suggestion matches
  // plan steps by title, so two identical titles would resolve to the first
  // stage's suggestion. Generate a unique title, not just a unique id.
  const taken = new Set(stages.map((stage) => stage.title.trim().toLowerCase()));
  let index = stages.length + 1;
  while (taken.has(`new stage ${index}`)) index += 1;
  return [
    ...stages,
    { id: nextResearchStageId(stages), title: `New stage ${index}`, goal: "", enabled: true },
  ];
}

export function removeResearchStage(
  stages: ReadonlyArray<ResearchStageConfig>,
  index: number,
): ReadonlyArray<ResearchStageConfig> {
  if (index < 0 || index >= stages.length) return stages;
  return stages.filter((_, at) => at !== index);
}

export function moveResearchStage(
  stages: ReadonlyArray<ResearchStageConfig>,
  index: number,
  delta: -1 | 1,
): ReadonlyArray<ResearchStageConfig> {
  const target = index + delta;
  if (index < 0 || index >= stages.length || target < 0 || target >= stages.length) return stages;
  const next = [...stages];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return stages;
  next.splice(target, 0, moved);
  return next;
}

export interface ResearchStagePatch {
  readonly title?: string;
  readonly goal?: string;
  readonly enabled?: boolean;
  /** null clears the suggestion; undefined leaves it untouched. */
  readonly suggestion?: { readonly instanceId: string; readonly model: string } | null;
  /** null clears the group; undefined leaves it untouched. */
  readonly parallelGroup?: number | null;
}

export function updateResearchStage(
  stages: ReadonlyArray<ResearchStageConfig>,
  index: number,
  patch: ResearchStagePatch,
): ReadonlyArray<ResearchStageConfig> {
  const stage = stages[index];
  if (stage === undefined) return stages;

  // Optional keys must be omitted, not set to undefined, so rebuild the
  // record instead of spreading patch values over it.
  const suggestion =
    patch.suggestion === undefined
      ? stage.suggestedInstanceId !== undefined && stage.suggestedModel !== undefined
        ? { instanceId: stage.suggestedInstanceId, model: stage.suggestedModel }
        : null
      : patch.suggestion;
  const nextParallelGroup =
    patch.parallelGroup === undefined
      ? stage.parallelGroup
      : patch.parallelGroup === null || patch.parallelGroup <= 0
        ? undefined
        : Math.round(patch.parallelGroup);

  const base = {
    id: stage.id,
    title: patch.title ?? stage.title,
    goal: patch.goal ?? stage.goal,
    enabled: patch.enabled ?? stage.enabled,
  };
  const withSuggestion =
    suggestion !== null && suggestion.instanceId.length > 0 && suggestion.model.length > 0
      ? {
          ...base,
          suggestedInstanceId: suggestion.instanceId as NonNullable<
            ResearchStageConfig["suggestedInstanceId"]
          >,
          suggestedModel: suggestion.model,
        }
      : base;
  const next: ResearchStageConfig =
    nextParallelGroup !== undefined
      ? { ...withSuggestion, parallelGroup: nextParallelGroup }
      : withSuggestion;
  return stages.map((existing, at) => (at === index ? next : existing));
}

export function resetResearchStages(): ReadonlyArray<ResearchStageConfig> {
  return DEFAULT_RESEARCH_STAGES;
}

export function isDefaultResearchStages(stages: ReadonlyArray<ResearchStageConfig>): boolean {
  if (stages.length !== DEFAULT_RESEARCH_STAGES.length) return false;
  return stages.every((stage, index) => {
    const fallback = DEFAULT_RESEARCH_STAGES[index];
    return (
      fallback !== undefined &&
      stage.id === fallback.id &&
      stage.title === fallback.title &&
      stage.goal === fallback.goal &&
      stage.enabled === fallback.enabled &&
      stage.suggestedInstanceId === fallback.suggestedInstanceId &&
      stage.suggestedModel === fallback.suggestedModel &&
      stage.parallelGroup === fallback.parallelGroup
    );
  });
}
