import type { MenuAction } from "@react-native-menu/menu";
import type {
  ModelSelection,
  PipelineTargetPolicy,
  ProviderOptionDescriptor,
  RuntimeMode,
} from "@d4research/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@d4research/shared/model";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";

// ultracode triggers a workflow rather than a reasoning level. Hide it from
// choices while still displaying values selected elsewhere.
export const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly shortLabel: string;
}> = [
  { mode: "approval-required", label: "Approve actions", shortLabel: "Approve" },
  { mode: "auto-accept-edits", label: "Auto-accept edits", shortLabel: "Edits" },
  { mode: "auto", label: "Auto", shortLabel: "Auto" },
  { mode: "full-access", label: "Full access", shortLabel: "Full" },
];

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}

export type ThreadSettingsMenuEvent =
  | { readonly type: "select-model"; readonly option: ModelOption }
  | { readonly type: "set-option"; readonly optionId: string; readonly value: string | boolean }
  | { readonly type: "set-runtime"; readonly mode: RuntimeMode }
  | { readonly type: "toggle-session-skill"; readonly name: string }
  | { readonly type: "set-dev-pipeline"; readonly scenarioName: string | null }
  | { readonly type: "set-pipeline-target-policy"; readonly policy: PipelineTargetPolicy };

export interface ThreadSettingsSessionSkill {
  readonly name: string;
  readonly enabled: boolean;
  readonly globallyEnabled: boolean;
  readonly disabled: boolean;
}

export interface ThreadSettingsDevPipelines {
  readonly names: ReadonlyArray<string>;
  readonly activeName: string | null;
  readonly supported: boolean;
}

export type ThreadSettingsMenu = {
  readonly actions: MenuAction[];
  /** Menu action id → the change it applies, for the onPressAction dispatch. */
  readonly events: ReadonlyMap<string, ThreadSettingsMenuEvent>;
};

// Native menu selections apply immediately without resigning the keyboard.
// Android and new-task drafts retain the settings sheet's staged edits.
export function buildThreadSettingsMenu(input: {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  readonly pipelineTargetPolicy: PipelineTargetPolicy;
  readonly sessionSkills?: ReadonlyArray<ThreadSettingsSessionSkill>;
  readonly devPipelines?: ThreadSettingsDevPipelines;
}): ThreadSettingsMenu {
  const events = new Map<string, ThreadSettingsMenuEvent>();
  const actions: MenuAction[] = [];

  const isSelected = (option: ModelOption) =>
    option.selection.instanceId === input.selectedModel?.instanceId &&
    option.selection.model === input.selectedModel.model;

  // Only root toggles stay open: keeping nested submenus presented traps their
  // expanded header without a route back to the root on iOS 16+.
  const keepPresented = { keepsMenuPresented: true } as const;

  const modelAction = (option: ModelOption, id: string): MenuAction => {
    events.set(id, { type: "select-model", option });
    return {
      id,
      title: option.label,
      ...(option.isDefault ? { subtitle: "Default" } : {}),
      state: isSelected(option) ? "on" : "off",
    };
  };

  const modelItems: MenuAction[] = [];
  const legacyItems: MenuAction[] = [];
  let selectedModelLabel: string | undefined;
  input.providerGroups.forEach((group, groupIndex) => {
    const groupItems: MenuAction[] = [];
    group.models.forEach((option, modelIndex) => {
      if (isSelected(option)) {
        selectedModelLabel = option.label;
      }
      const id = `model:${groupIndex}:${modelIndex}`;
      // A highlighted legacy model stays in the main list (mirroring the
      // sheet) so the checkmark isn't hidden behind the Legacy fold.
      if (option.isLegacy && !isSelected(option)) {
        legacyItems.push(modelAction(option, id));
      } else {
        groupItems.push(modelAction(option, id));
      }
    });
    if (groupItems.length === 0) {
      return;
    }
    // A thread is bound to one harness, so provider sections only appear for
    // multi-group callers (the new-task draft, if it ever adopts the menu).
    if (input.providerGroups.length > 1) {
      modelItems.push({
        id: `model-group:${groupIndex}`,
        title: group.providerLabel,
        displayInline: true,
        subactions: groupItems,
      });
    } else {
      modelItems.push(...groupItems);
    }
  });
  if (legacyItems.length > 0) {
    modelItems.push({
      id: "legacy-models",
      title: "Legacy Models",
      subactions: legacyItems,
    });
  }
  if (modelItems.length > 0) {
    actions.push({
      id: "model",
      title: "Model",
      ...(selectedModelLabel === undefined
        ? input.selectedModel
          ? { subtitle: input.selectedModel.model }
          : {}
        : { subtitle: selectedModelLabel }),
      subactions: modelItems,
    });
  }

  for (const descriptor of input.optionDescriptors) {
    if (descriptor.type === "boolean") {
      const id = `option:${descriptor.id}`;
      events.set(id, {
        type: "set-option",
        optionId: descriptor.id,
        value: !(descriptor.currentValue ?? false),
      });
      actions.push({
        id,
        title: descriptor.label,
        state: descriptor.currentValue ? "on" : "off",
        attributes: keepPresented,
      });
      continue;
    }
    const currentValue = getProviderOptionCurrentValue(descriptor);
    const choices = selectableChoices(descriptor).map((choice): MenuAction => {
      const id = `option:${descriptor.id}:${choice.id}`;
      events.set(id, { type: "set-option", optionId: descriptor.id, value: choice.id });
      return {
        id,
        title: choice.label,
        state: choice.id === currentValue ? "on" : "off",
      };
    });
    if (choices.length === 0) {
      continue;
    }
    const currentLabel = getProviderOptionCurrentLabel(descriptor);
    actions.push({
      id: `option:${descriptor.id}`,
      title: descriptor.label,
      ...(currentLabel === undefined ? {} : { subtitle: currentLabel }),
      subactions: choices,
    });
  }

  const runtimeLabel = RUNTIME_MODE_CHOICES.find(
    (choice) => choice.mode === input.runtimeMode,
  )?.label;
  actions.push({
    id: "runtime",
    title: "Runtime",
    ...(runtimeLabel === undefined ? {} : { subtitle: runtimeLabel }),
    subactions: RUNTIME_MODE_CHOICES.map((choice): MenuAction => {
      const id = `runtime:${choice.mode}`;
      events.set(id, { type: "set-runtime", mode: choice.mode });
      return {
        id,
        title: choice.label,
        state: choice.mode === input.runtimeMode ? "on" : "off",
      };
    }),
  });

  if (input.sessionSkills && input.sessionSkills.length > 0) {
    actions.push({
      id: "session-skills",
      title: "Chat skills",
      subtitle: `${input.sessionSkills.filter((skill) => skill.enabled).length} enabled`,
      subactions: input.sessionSkills.map((skill): MenuAction => {
        const id = `session-skill:${encodeURIComponent(skill.name)}`;
        events.set(id, { type: "toggle-session-skill", name: skill.name });
        return {
          id,
          title: skill.globallyEnabled ? `${skill.name} (Global)` : skill.name,
          state: skill.enabled ? "on" : "off",
          ...(skill.disabled ? { attributes: { disabled: true } } : {}),
        };
      }),
    });
  }

  if (input.devPipelines && input.devPipelines.names.length > 0) {
    const choices: MenuAction[] = [];
    const offId = "dev-pipeline:off";
    events.set(offId, { type: "set-dev-pipeline", scenarioName: null });
    choices.push({
      id: offId,
      title: "Off",
      state: input.devPipelines.activeName === null ? "on" : "off",
    });
    for (const name of input.devPipelines.names) {
      const id = `dev-pipeline:${encodeURIComponent(name)}`;
      events.set(id, { type: "set-dev-pipeline", scenarioName: name });
      choices.push({
        id,
        title: name,
        state: input.devPipelines.activeName === name ? "on" : "off",
        ...(input.devPipelines.supported ? {} : { attributes: { disabled: true } }),
      });
    }
    actions.push({
      id: "dev-pipeline",
      title: "Dev pipeline",
      subtitle: input.devPipelines.supported
        ? (input.devPipelines.activeName ?? "Off")
        : "Unavailable",
      subactions: choices,
    });
  }

  const fallbackPolicyId = "pipeline-target-policy:labeled-fallback";
  const exactPolicyId = "pipeline-target-policy:exact";
  events.set(fallbackPolicyId, {
    type: "set-pipeline-target-policy",
    policy: "labeled-fallback",
  });
  events.set(exactPolicyId, { type: "set-pipeline-target-policy", policy: "exact" });
  actions.push({
    id: "pipeline-target-policy",
    title: "Pipeline targets",
    subtitle: input.pipelineTargetPolicy === "labeled-fallback" ? "Labeled fallback" : "Exact only",
    subactions: [
      {
        id: fallbackPolicyId,
        title: "Use labeled fallback",
        subtitle: "Only when the pipeline lists it",
        state: input.pipelineTargetPolicy === "labeled-fallback" ? "on" : "off",
      },
      {
        id: exactPolicyId,
        title: "Exact targets only",
        state: input.pipelineTargetPolicy === "exact" ? "on" : "off",
      },
    ],
  });

  return { actions, events };
}
