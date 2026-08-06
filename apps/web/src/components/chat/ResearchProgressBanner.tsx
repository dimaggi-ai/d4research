import { memo, useState } from "react";
import { CheckIcon, ChevronDownIcon, LoaderCircle, TelescopeIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export interface ResearchProgressStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface ResearchStageSuggestionSource {
  readonly title: string;
  readonly suggestedInstanceId?: string | undefined;
  readonly suggestedModel?: string | undefined;
}

export interface ResearchStageSuggestion {
  readonly instanceId: string;
  readonly model: string;
}

function normalizeStageTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * The provider/model the active research stage suggests, when it differs from
 * the thread's current selection. Matching is by stage title because plan
 * steps are free text the provider echoes back — the prompt asks for exact
 * stage titles, so a title match is the stage. Returns null when nothing is
 * suggested or the suggestion is already active; acting on it is always a
 * user decision.
 */
export function deriveActiveStageSuggestion(input: {
  readonly steps: ReadonlyArray<ResearchProgressStep>;
  readonly stages: ReadonlyArray<ResearchStageSuggestionSource>;
  readonly current: { readonly instanceId: string; readonly model: string } | null;
}): ResearchStageSuggestion | null {
  const { current } = summarizeResearchProgress(input.steps);
  if (current === null) return null;
  const stage = input.stages.find(
    (candidate) => normalizeStageTitle(candidate.title) === normalizeStageTitle(current),
  );
  if (!stage?.suggestedInstanceId || !stage.suggestedModel) return null;
  if (
    input.current !== null &&
    input.current.instanceId === stage.suggestedInstanceId &&
    input.current.model === stage.suggestedModel
  ) {
    return null;
  }
  return { instanceId: stage.suggestedInstanceId, model: stage.suggestedModel };
}

export function summarizeResearchProgress(steps: ReadonlyArray<ResearchProgressStep>): {
  readonly completed: number;
  readonly total: number;
  readonly current: string | null;
} {
  const completed = steps.filter((step) => step.status === "completed").length;
  const active = steps.find((step) => step.status === "inProgress");
  return {
    completed,
    total: steps.length,
    // With no step explicitly in progress, the first unfinished one is what the
    // lead is about to work on — better than showing nothing between stages.
    current: (active ?? steps.find((step) => step.status !== "completed"))?.step ?? null,
  };
}

/**
 * Deep research runs for a long time across delegated agents, and its status
 * previously lived only in prose the user had to scroll for (or ask for). The
 * lead maintains its stages as plan steps; this renders them as always-visible
 * progress above the composer.
 */
export const ResearchProgressBanner = memo(function ResearchProgressBanner({
  steps,
  isRunning,
  suggestionLabel,
  onApplySuggestion,
}: {
  readonly steps: ReadonlyArray<ResearchProgressStep>;
  readonly isRunning: boolean;
  /** Label for the active stage's suggested provider/model, if any. */
  readonly suggestionLabel?: string | null;
  readonly onApplySuggestion?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const { completed, total, current } = summarizeResearchProgress(steps);
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-b border-border/50 px-3 py-2" data-research-progress="true">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label="Research progress"
      >
        <TelescopeIcon className="size-3.5 shrink-0 text-violet-400" />
        <span className="shrink-0 text-xs font-medium text-foreground">Research</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {completed}/{total}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {current ?? "All stages complete"}
        </span>
        {isRunning ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {suggestionLabel && onApplySuggestion ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Stage suggests {suggestionLabel}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
            onClick={onApplySuggestion}
          >
            Hand off
          </button>
        </div>
      ) : null}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-violet-400 transition-[width]"
          style={{ width: `${percentage}%` }}
        />
      </div>
      {expanded ? (
        <ol className="mt-2 space-y-1">
          {steps.map((step, index) => (
            <li
              // Plan steps carry no id and are never reordered — the provider
              // rewrites the list in place — so position is their identity.
              // eslint-disable-next-line react/no-array-index-key
              key={`${index}-${step.step}`}
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <span className="mt-0.5 shrink-0">
                {step.status === "completed" ? (
                  <CheckIcon className="size-3 text-emerald-500" />
                ) : step.status === "inProgress" ? (
                  <LoaderCircle className="size-3 animate-spin text-violet-400" />
                ) : (
                  <span className="block size-3 rounded-full border border-muted-foreground/40" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1",
                  step.status === "completed" && "line-through opacity-60",
                  step.status === "inProgress" && "text-foreground",
                )}
              >
                {step.step}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
});
