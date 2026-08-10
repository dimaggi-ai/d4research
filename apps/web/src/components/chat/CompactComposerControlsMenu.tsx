import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { shouldExitPlanForDevPipelineSelection } from "../../devPipeline";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

/** Sentinel for the "no research" row; scenario names can never be empty. */
export const RESEARCH_OFF_VALUE = "__research_off__";

/**
 * The Build control is a picker: ordinary build, one of the dev pipelines, or
 * plan. Sentinels keep those two fixed rows from colliding with a pipeline a
 * user happens to name "build".
 */
export const BUILD_MODE_VALUE = "__build__";
export const PLAN_MODE_VALUE = "__plan__";

export function compactInteractionModeSelection(input: {
  readonly currentMode: ProviderInteractionMode;
  readonly nextMode: ProviderInteractionMode;
}): { readonly toggleMode: true; readonly clearDevPipeline: boolean } | null {
  if (input.nextMode === input.currentMode) return null;
  return {
    toggleMode: true,
    clearDevPipeline: input.nextMode === "plan",
  };
}

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  isResearchMode: boolean;
  showInteractionModeToggle: boolean;
  canStartResearch: boolean;
  researchScenarios: ReadonlyArray<string>;
  activeResearchScenario: string | null;
  devPipelines: ReadonlyArray<string>;
  activeDevPipeline: string | null;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onSelectResearchScenario: (scenarioName: string | null) => void;
  onSelectDevPipeline: (scenarioName: string | null) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value) return;
                const transition = compactInteractionModeSelection({
                  currentMode: props.interactionMode,
                  nextMode: value as ProviderInteractionMode,
                });
                if (transition === null) return;
                if (transition.clearDevPipeline) props.onSelectDevPipeline(null);
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        {/* Pipelines are provider-agnostic orchestration, so they remain
            available even when a provider has no native Plan mode. */}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Dev pipeline</div>
        <MenuRadioGroup
          value={props.activeDevPipeline ?? BUILD_MODE_VALUE}
          onValueChange={(value) => {
            if (!value) return;
            const scenarioName = value === BUILD_MODE_VALUE ? null : String(value);
            if (shouldExitPlanForDevPipelineSelection(props.interactionMode, scenarioName)) {
              props.onToggleInteractionMode();
            }
            props.onSelectDevPipeline(scenarioName);
          }}
        >
          <MenuRadioItem value={BUILD_MODE_VALUE}>Build</MenuRadioItem>
          {props.devPipelines.map((pipeline) => (
            <MenuRadioItem key={pipeline} value={pipeline}>
              {pipeline}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuDivider />
        {props.canStartResearch ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Research scenario
            </div>
            <MenuRadioGroup
              value={
                props.isResearchMode
                  ? (props.activeResearchScenario ?? RESEARCH_OFF_VALUE)
                  : RESEARCH_OFF_VALUE
              }
              onValueChange={(value) => {
                if (!value) return;
                props.onSelectResearchScenario(value === RESEARCH_OFF_VALUE ? null : String(value));
              }}
            >
              <MenuRadioItem value={RESEARCH_OFF_VALUE}>Off</MenuRadioItem>
              {props.researchScenarios.map((scenario) => (
                <MenuRadioItem key={scenario} value={scenario}>
                  {scenario}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agent access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
