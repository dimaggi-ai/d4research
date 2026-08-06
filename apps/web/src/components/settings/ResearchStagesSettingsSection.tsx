import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { ProviderInstanceId, ResearchStageConfig } from "@t3tools/contracts";
import { RESEARCH_STAGE_MAX_COUNT } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import {
  addResearchStage,
  isDefaultResearchStages,
  moveResearchStage,
  removeResearchStage,
  resetResearchStages,
  updateResearchStage,
} from "./researchStagesSettings";

/**
 * Settings → Deep research: the ordered stage list a research thread follows.
 * Per-stage provider/model picks are suggestions surfaced in the research
 * prompt and progress banner — the user hands off; nothing runs on its own.
 */
export function ResearchStagesSettingsSection({
  stages,
  onStagesChange,
  instanceEntries,
  modelOptionsByInstance,
}: {
  readonly stages: ReadonlyArray<ResearchStageConfig>;
  readonly onStagesChange: (stages: ReadonlyArray<ResearchStageConfig>) => void;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}) {
  const firstEntry = instanceEntries[0];
  const commit = (next: ReadonlyArray<ResearchStageConfig>) => {
    if (next !== stages) onStagesChange(next);
  };

  return (
    <SettingsSection
      title="Deep research"
      id="deep-research"
      headerAction={
        !isDefaultResearchStages(stages) ? (
          <SettingResetButton
            label="research stages"
            onClick={() => onStagesChange(resetResearchStages())}
          />
        ) : null
      }
    >
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Stages a <span className="font-mono">#deep-research</span> thread works through, in order. A
        stage's provider/model is a suggestion: the thread shows a hand-off shortcut when that stage
        becomes active, and nothing switches without you.
      </p>

      <div className="space-y-2 px-3 sm:px-4" data-testid="research-stages-list">
        {stages.map((stage, index) => (
          <div
            key={stage.id}
            className="rounded-lg border border-border/70 bg-muted/25 p-3"
            data-testid={`research-stage-${stage.id}`}
          >
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <DraftInput
                value={stage.title}
                onCommit={(title) => {
                  if (title.trim().length > 0)
                    commit(updateResearchStage(stages, index, { title }));
                }}
                placeholder="Stage title"
                aria-label={`Stage ${index + 1} title`}
                className="min-w-0 flex-1 text-sm"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Move stage ${index + 1} up`}
                disabled={index === 0}
                onClick={() => commit(moveResearchStage(stages, index, -1))}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Move stage ${index + 1} down`}
                disabled={index === stages.length - 1}
                onClick={() => commit(moveResearchStage(stages, index, 1))}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove stage ${index + 1}`}
                disabled={stages.length === 1}
                onClick={() => commit(removeResearchStage(stages, index))}
              >
                <X className="size-3.5" />
              </Button>
              <Switch
                checked={stage.enabled}
                onCheckedChange={(checked) =>
                  commit(updateResearchStage(stages, index, { enabled: Boolean(checked) }))
                }
                aria-label={`Enable stage ${index + 1}`}
              />
            </div>

            <DraftInput
              value={stage.goal}
              onCommit={(goal) => commit(updateResearchStage(stages, index, { goal }))}
              placeholder="What this stage should achieve"
              aria-label={`Stage ${index + 1} goal`}
              className="mt-2 w-full text-xs"
            />

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">Suggested model</span>
                {stage.suggestedInstanceId !== undefined && stage.suggestedModel !== undefined ? (
                  <>
                    <ProviderModelPicker
                      activeInstanceId={stage.suggestedInstanceId}
                      model={stage.suggestedModel}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onInstanceModelChange={(instanceId, model) =>
                        commit(
                          updateResearchStage(stages, index, {
                            suggestion: { instanceId: String(instanceId), model },
                          }),
                        )
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-xs"
                      onClick={() =>
                        commit(updateResearchStage(stages, index, { suggestion: null }))
                      }
                    >
                      Clear
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    disabled={firstEntry === undefined || firstEntry.models.length === 0}
                    onClick={() => {
                      const model = firstEntry?.models[0]?.slug;
                      if (firstEntry === undefined || model === undefined) return;
                      commit(
                        updateResearchStage(stages, index, {
                          suggestion: { instanceId: String(firstEntry.instanceId), model },
                        }),
                      );
                    }}
                  >
                    Suggest a model
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Parallel group</span>
                <NumberField
                  value={stage.parallelGroup ?? 0}
                  min={0}
                  step={1}
                  size="sm"
                  className="w-24"
                  onValueChange={(value) => {
                    if (value === null) return;
                    commit(
                      updateResearchStage(stages, index, {
                        parallelGroup: value <= 0 ? null : Math.round(value),
                      }),
                    );
                  }}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement
                      aria-label={`Decrease stage ${index + 1} parallel group`}
                    />
                    <NumberFieldInput aria-label={`Stage ${index + 1} parallel group (0 = none)`} />
                    <NumberFieldIncrement
                      aria-label={`Increase stage ${index + 1} parallel group`}
                    />
                  </NumberFieldGroup>
                </NumberField>
              </div>
            </div>
          </div>
        ))}

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={stages.length >= RESEARCH_STAGE_MAX_COUNT}
          onClick={() => commit(addResearchStage(stages))}
        >
          <Plus className="size-3.5" />
          Add stage
        </Button>
      </div>
    </SettingsSection>
  );
}
