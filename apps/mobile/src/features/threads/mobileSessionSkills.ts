import {
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  type ProviderInteractionMode,
  type SkillsInventoryEntry,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyDevTrigger,
  providerDriverSupportsPipelineOrchestration,
} from "@t3tools/shared/devPipeline";
import { stripResearchTrigger } from "@t3tools/shared/researchPipeline";

export function mobilePromptForInteractionMode(
  prompt: string,
  nextMode: ProviderInteractionMode,
): string {
  return nextMode === "plan" ? applyDevTrigger(prompt, null) : prompt;
}

export function mobilePromptForDevPipeline(prompt: string, scenarioName: string | null): string {
  return applyDevTrigger(stripResearchTrigger(prompt), scenarioName);
}

export function mobileProviderSupportsDelegationPipelines(driver: string | undefined): boolean {
  return providerDriverSupportsPipelineOrchestration(driver ?? "");
}

export function projectSkillNamesFromInventory(
  entries: ReadonlyArray<SkillsInventoryEntry>,
): Array<string> {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.kind === "skill" && entry.scope === "project")
        .map((entry) => entry.name),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function listMobileSessionSkillNames(input: {
  readonly providers: ReadonlyArray<Pick<ServerProvider, "skills">>;
  readonly globalNames: ReadonlyArray<string>;
  readonly sessionNames: ReadonlyArray<string>;
  readonly projectNames?: ReadonlyArray<string>;
}): Array<string> {
  const names = new Set([
    ...input.globalNames,
    ...input.sessionNames,
    ...(input.projectNames ?? []),
  ]);
  for (const provider of input.providers) {
    for (const skill of provider.skills) {
      if (skill.enabled && skill.path.trim().length > 0) names.add(skill.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** Null means the globally enabled row is intentionally locked at chat scope. */
export function toggleMobileSessionSkill(input: {
  readonly globalNames: ReadonlyArray<string>;
  readonly sessionNames: ReadonlyArray<string>;
  readonly name: string;
}): Array<string> | null {
  if (input.globalNames.includes(input.name)) return null;
  const globalSet = new Set(input.globalNames);
  const sessionNames = input.sessionNames.filter((name) => !globalSet.has(name));
  if (sessionNames.includes(input.name)) {
    return sessionNames.filter((candidate) => candidate !== input.name);
  }
  const availableSessionSlots = Math.max(
    0,
    ENABLED_BY_DEFAULT_SKILL_MAX_COUNT - new Set(input.globalNames).size,
  );
  return [...new Set([...sessionNames, input.name])].slice(0, availableSessionSlots);
}

export function mobileSessionSkillSettingsPatch(
  threadId: ThreadId,
  name: string,
  enabled: boolean,
) {
  return {
    skills: {
      setEnabledForThreadSkill: { threadId, name, enabled },
    },
  } as const;
}
