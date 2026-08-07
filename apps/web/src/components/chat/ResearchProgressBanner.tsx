import { memo, useState } from "react";
import { CheckIcon, ChevronDownIcon, LoaderCircle, TelescopeIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export interface ResearchProgressStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/**
 * Steps the research banner should render. Until the running turn writes its
 * own plan, the active plan falls back to the previous turn's so todo lists
 * persist across follow-ups — fine mid-research, where partial stages carry
 * across handoffs, but a *fully completed* plan inherited from an earlier turn
 * is history, not progress: rendering it shows a 100% bar the moment a new
 * research starts. Suppress exactly that case; the banner reappears when the
 * lead posts its stage plan.
 */
export function deriveResearchBannerSteps(input: {
  readonly steps: ReadonlyArray<ResearchProgressStep>;
  readonly planTurnId: string | null;
  readonly latestTurnId: string | null;
  readonly isRunning: boolean;
}): ReadonlyArray<ResearchProgressStep> {
  const staleCompletedPlan =
    input.isRunning &&
    input.planTurnId !== null &&
    input.latestTurnId !== null &&
    input.planTurnId !== input.latestTurnId &&
    input.steps.length > 0 &&
    input.steps.every((step) => step.status === "completed");
  return staleCompletedPlan ? [] : input.steps;
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
  onDismiss,
}: {
  readonly steps: ReadonlyArray<ResearchProgressStep>;
  readonly isRunning: boolean;
  /** Closes the banner. Offered once the research is no longer running. */
  readonly onDismiss?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const { completed, total, current } = summarizeResearchProgress(steps);
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-b border-border/50 px-3 py-2" data-research-progress="true">
      <div className="flex w-full min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
        {onDismiss ? (
          <button
            type="button"
            aria-label="Dismiss research progress"
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onDismiss}
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
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
