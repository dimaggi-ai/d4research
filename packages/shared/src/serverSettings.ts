import {
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  isProviderDriverKind,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@d4research/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import { setEnabledSkillsForThread, updateEnabledSkillForThread } from "./enabledSkillsContext.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isModelSelectionProviderEnabled(settings, selection)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true && isProviderAvailable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function applyScenarioPatch(
  current: ServerSettings["research"]["scenarios"],
  patch: {
    readonly scenarios?: ServerSettings["research"]["scenarios"];
    readonly upsertScenario?: {
      readonly name: string;
      readonly pipelinePrompt: string;
      readonly promptFiles?: ServerSettings["research"]["scenarios"][number]["promptFiles"];
    };
    readonly removeScenario?: string;
  },
): ServerSettings["research"]["scenarios"] {
  let scenarios = patch.scenarios ? [...patch.scenarios] : [...current];
  if (patch.upsertScenario) {
    const index = scenarios.findIndex((scenario) => scenario.name === patch.upsertScenario?.name);
    const existing = index === -1 ? undefined : scenarios[index];
    const upserted = {
      ...patch.upsertScenario,
      promptFiles: patch.upsertScenario.promptFiles ?? existing?.promptFiles ?? [],
    };
    if (index === -1) scenarios.push(upserted);
    else scenarios[index] = upserted;
  }
  if (patch.removeScenario) {
    scenarios = scenarios.filter((scenario) => scenario.name !== patch.removeScenario);
  }
  return scenarios;
}

function mergeUsageLimitSources(
  current: ServerSettings["usageLimitSources"],
  patch: NonNullable<ServerSettingsPatch["usageLimitSources"]>,
): ServerSettings["usageLimitSources"] {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) next.delete(id);
    else next.set(id, config);
  }
  return Object.fromEntries(next) as ServerSettings["usageLimitSources"];
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    skills: skillsPatch,
    research: researchPatch,
    dev: devPatch,
    usageLimitSources: usageLimitSourcesPatch,
    ...patchForMerge
  } = patch;
  const {
    upsertScenario: researchUpsert,
    removeScenario: researchRemove,
    ...researchForMerge
  } = researchPatch ?? {};
  const { upsertScenario: devUpsert, removeScenario: devRemove, ...devForMerge } = devPatch ?? {};
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const next = deepMerge(current, {
    ...patchForMerge,
    ...(researchPatch ? { research: researchForMerge } : {}),
    ...(devPatch ? { dev: devForMerge } : {}),
  });
  const nextResearchScenarios = researchPatch
    ? applyScenarioPatch(current.research.scenarios, researchPatch)
    : next.research.scenarios;
  const nextDevScenarios = devPatch
    ? applyScenarioPatch(current.dev.scenarios, devPatch)
    : next.dev.scenarios;
  const replacedSkills = {
    ...next.skills,
    ...(skillsPatch?.enabledByDefault !== undefined
      ? { enabledByDefault: skillsPatch.enabledByDefault }
      : {}),
    ...(skillsPatch?.enabledByThread !== undefined
      ? { enabledByThread: skillsPatch.enabledByThread }
      : {}),
  };
  const defaultSkillUpdate = skillsPatch?.setEnabledByDefault;
  const globallyUpdatedSkills = defaultSkillUpdate
    ? {
        ...replacedSkills,
        enabledByDefault: defaultSkillUpdate.enabled
          ? [...new Set([...replacedSkills.enabledByDefault, defaultSkillUpdate.name])].slice(
              0,
              ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
            )
          : replacedSkills.enabledByDefault.filter((name) => name !== defaultSkillUpdate.name),
      }
    : replacedSkills;
  const threadSkillUpdate = skillsPatch?.setEnabledForThread;
  const replacedThreadSkills = threadSkillUpdate
    ? {
        ...globallyUpdatedSkills,
        enabledByThread: setEnabledSkillsForThread(
          globallyUpdatedSkills.enabledByThread,
          threadSkillUpdate.threadId,
          threadSkillUpdate.names,
        ),
      }
    : globallyUpdatedSkills;
  const threadSkillToggle = skillsPatch?.setEnabledForThreadSkill;
  const nextSkills = threadSkillToggle
    ? {
        ...replacedThreadSkills,
        enabledByThread: updateEnabledSkillForThread(
          replacedThreadSkills.enabledByThread,
          threadSkillToggle.threadId,
          threadSkillToggle.name,
          threadSkillToggle.enabled,
        ),
      }
    : replacedThreadSkills;
  const nextWithReplacementsBase = {
    ...next,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(usageLimitSourcesPatch !== undefined
      ? {
          usageLimitSources: mergeUsageLimitSources(
            current.usageLimitSources,
            usageLimitSourcesPatch,
          ),
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(researchPatch?.scenarios !== undefined ||
    researchUpsert !== undefined ||
    researchRemove !== undefined ||
    researchPatch?.promptFiles !== undefined
      ? {
          research: {
            ...next.research,
            scenarios: nextResearchScenarios,
            ...(researchRemove === current.research.activeScenario &&
            researchPatch?.activeScenario === undefined
              ? { activeScenario: nextResearchScenarios[0]?.name ?? "" }
              : {}),
            ...(researchPatch?.promptFiles !== undefined
              ? { promptFiles: researchPatch.promptFiles }
              : {}),
          },
        }
      : {}),
    ...(devPatch?.scenarios !== undefined || devUpsert !== undefined || devRemove !== undefined
      ? {
          dev: {
            ...next.dev,
            scenarios: nextDevScenarios,
            ...(devRemove === current.dev.activeScenario && devPatch?.activeScenario === undefined
              ? { activeScenario: nextDevScenarios[0]?.name ?? "" }
              : {}),
          },
        }
      : {}),
    ...(skillsPatch !== undefined ? { skills: nextSkills } : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
