import { memo, useEffect, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderCircle,
  TelescopeIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "~/lib/contextWindow";

export interface ResearchProgressStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/** One `research_delegate` call, as read back off the thread's activity log. */
export interface ResearchDelegation {
  readonly callId: string | null;
  readonly step: string;
  readonly visit: number;
  readonly target: string;
  readonly settled: boolean;
  /** Delegations left in the run's budget, from the tool's own result. */
  readonly remainingBudget: number | null;
  readonly failed: boolean;
  readonly startedAtMs: number | null;
  readonly lastActivityAtMs: number | null;
  readonly durationMs: number | null;
}

interface ActivityLike {
  readonly kind: string;
  readonly payload: unknown;
  readonly summary?: string;
  readonly createdAt?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function findNestedNumber(value: unknown, key: string, depth = 0): number | null {
  if (depth > 6) return null;
  const parsed = parseJsonRecord(value);
  if (parsed === null) return null;
  if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) return parsed[key];
  for (const child of Object.values(parsed)) {
    const found = findNestedNumber(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findNestedBoolean(value: unknown, keys: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 6) return false;
  const parsed = parseJsonRecord(value);
  if (parsed === null) return false;
  for (const [key, child] of Object.entries(parsed)) {
    if (keys.has(key) && child === true) return true;
    if (findNestedBoolean(child, keys, depth + 1)) return true;
  }
  return false;
}

interface NormalizedDelegateActivity {
  readonly callId: string | null;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly failed: boolean;
}

/**
 * Provider adapters do not share one MCP payload shape. Claude uses
 * `data.toolName/input/result`, Codex nests `item.tool/arguments/result`,
 * OpenCode uses `tool/state`, and ACP exposes `rawInput/rawOutput`. Normalize
 * those real lifecycle shapes before the banner derives its run ledger.
 */
const firstString = (...values: ReadonlyArray<unknown>): string | null => {
  const found = values.find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof found === "string" ? found : null;
};

const namesResearchDelegate = (value: unknown): boolean =>
  typeof value === "string" && /(?:^|__|·\s*)research_delegate(?:\s+started)?$/i.test(value);

function readDelegatePayload(activity: ActivityLike): NormalizedDelegateActivity | null {
  const envelope = asRecord(activity.payload);
  if (envelope === null) return null;
  const data = asRecord(envelope.data) ?? {};
  const item = asRecord(data.item);
  const state = asRecord(data.state);
  const rawInput = parseJsonRecord(data.rawInput);
  const projected = asRecord(data.researchDelegate);
  if (projected !== null) {
    return {
      callId: firstString(
        projected.callId,
        envelope.toolCallId,
        envelope.toolUseId,
        data.toolCallId,
        item?.id,
      ),
      input: projected,
      output: projected,
      failed: projected.failed === true,
    };
  }
  const toolNameCandidates = [
    activity.summary,
    envelope.title,
    data.toolName,
    data.tool,
    item?.tool,
    item?.name,
    rawInput?.toolName,
    rawInput?.tool,
    rawInput?.name,
  ];
  if (!toolNameCandidates.some(namesResearchDelegate)) {
    return null;
  }
  const input =
    asRecord(data.input) ??
    asRecord(item?.arguments) ??
    asRecord(item?.input) ??
    asRecord(state?.input) ??
    asRecord(rawInput?.arguments) ??
    asRecord(rawInput?.input) ??
    rawInput ??
    {};
  const output = data.output ?? item?.result ?? state?.output ?? data.rawOutput ?? data.result;
  return {
    callId: firstString(
      envelope.toolCallId,
      envelope.toolUseId,
      data.toolCallId,
      item?.id,
      state?.toolCallId,
      rawInput?.toolUseId,
    ),
    input,
    output,
    failed:
      envelope.status === "failed" ||
      state?.status === "error" ||
      findNestedBoolean(output, new Set(["is_error", "isError"])),
  };
}

/**
 * Reconstructs the delegation trail from tool activities. The plan tool only
 * says which step is in progress; it cannot show that a step is on its second
 * visit, which model is answering, or how much of the run's budget is left —
 * all of which the delegate tool already reports and the UI was discarding.
 */
export function deriveResearchDelegations(
  activities: ReadonlyArray<ActivityLike>,
): ReadonlyArray<ResearchDelegation> {
  const delegations: Array<ResearchDelegation> = [];
  for (const activity of activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const activityAtMs = activity.createdAt ? Date.parse(activity.createdAt) : Number.NaN;
    const occurredAtMs = Number.isFinite(activityAtMs) ? activityAtMs : null;
    if (activity.kind === "tool.progress") {
      const progress = asRecord(activity.payload);
      const callId = firstString(progress?.toolCallId, progress?.toolUseId);
      if (callId === null) continue;
      const existing = delegations.findIndex((entry) => entry.callId === callId);
      if (existing < 0) continue;
      const current = delegations[existing]!;
      const elapsedSeconds = findNestedNumber(progress, "elapsedSeconds");
      delegations[existing] = {
        ...current,
        startedAtMs:
          current.startedAtMs ??
          (occurredAtMs !== null && elapsedSeconds !== null
            ? Math.max(0, occurredAtMs - elapsedSeconds * 1_000)
            : null),
        lastActivityAtMs: occurredAtMs ?? current.lastActivityAtMs,
      };
      continue;
    }
    const data = readDelegatePayload(activity);
    if (data === null) continue;
    const input = data.input;
    const step = typeof input.step === "string" ? input.step : "";
    const target = typeof input.target === "string" ? input.target : "";
    if (!step && !target && data.callId === null) continue;
    const visit = typeof input.visit === "number" ? input.visit : 1;
    const settled = activity.kind === "tool.completed";
    const failed = settled && data.failed;
    const remainingBudget = findNestedNumber(data.output, "remainingBudget");
    const durationMs = findNestedNumber(data.output, "durationMs");

    // A started call is superseded by its own completion.
    const existing = delegations.findIndex((entry) =>
      data.callId !== null
        ? entry.callId === data.callId
        : entry.step === step && entry.target === target && entry.visit === visit,
    );
    const previous = existing >= 0 ? delegations[existing]! : null;
    const startedAtMs =
      previous?.startedAtMs ??
      (occurredAtMs !== null
        ? Math.max(0, occurredAtMs - (settled ? (durationMs ?? 0) : 0))
        : null);
    const next: ResearchDelegation = {
      callId: data.callId ?? previous?.callId ?? null,
      step: step || previous?.step || "",
      visit,
      target: target || previous?.target || "",
      settled,
      remainingBudget,
      failed,
      startedAtMs,
      lastActivityAtMs: occurredAtMs ?? previous?.lastActivityAtMs ?? startedAtMs,
      durationMs,
    };
    if (existing >= 0) delegations[existing] = next;
    else delegations.push(next);
  }
  return delegations;
}

export interface ResearchDelegationSummary {
  readonly inFlight: ResearchDelegation | null;
  readonly used: number;
  readonly failures: number;
  readonly remainingBudget: number | null;
  /** Visits already spent per step, so a rerun is visible as "visit 2 of 3". */
  readonly visitsByStep: ReadonlyMap<string, number>;
}

export function summarizeResearchDelegations(
  delegations: ReadonlyArray<ResearchDelegation>,
): ResearchDelegationSummary {
  const visitsByStep = new Map<string, number>();
  let remainingBudget: number | null = null;
  let failures = 0;
  for (const delegation of delegations) {
    visitsByStep.set(
      delegation.step,
      Math.max(visitsByStep.get(delegation.step) ?? 0, delegation.visit),
    );
    if (delegation.remainingBudget !== null) remainingBudget = delegation.remainingBudget;
    if (delegation.failed) failures += 1;
  }
  return {
    inFlight: delegations.find((delegation) => !delegation.settled) ?? null,
    used: delegations.length,
    failures,
    remainingBudget,
    visitsByStep,
  };
}

/** Trims `claudeAgent:claude-fable-5` to `claude-fable-5` for a tight label. */
export function shortTargetLabel(target: string): string {
  if (!target) return "Delegate";
  const separator = target.indexOf(":");
  return separator > 0 ? target.slice(separator + 1) : target;
}

export function formatDelegationElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function useDelegationClock(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return nowMs;
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
  pipelineKind = "research",
  steps,
  isRunning,
  contextTokens,
  delegations,
  onDismiss,
}: {
  readonly pipelineKind?: "research" | "dev";
  readonly steps: ReadonlyArray<ResearchProgressStep>;
  readonly isRunning: boolean;
  /** Context-window tokens consumed so far, shown as the research grows. */
  readonly contextTokens?: number | null;
  /** Delegate calls made so far, so reruns and budget are visible. */
  readonly delegations?: ReadonlyArray<ResearchDelegation>;
  /** Closes the banner. Offered once the research is no longer running. */
  readonly onDismiss?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const delegationList = delegations ?? [];
  const delegationSummary = summarizeResearchDelegations(delegationList);
  const { inFlight, used, failures, remainingBudget, visitsByStep } = delegationSummary;
  const nowMs = useDelegationClock(inFlight !== null);
  if (steps.length === 0 && delegationList.length === 0) return null;
  const { completed, total, current } = summarizeResearchProgress(steps);
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isDev = pipelineKind === "dev";
  const PipelineIcon = isDev ? BotIcon : TelescopeIcon;
  const pipelineLabel = isDev
    ? isRunning
      ? "Building"
      : "Build"
    : isRunning
      ? "Researching"
      : "Research";
  const elapsedMs =
    inFlight?.startedAtMs !== null && inFlight?.startedAtMs !== undefined
      ? Math.max(0, nowMs - inFlight.startedAtMs)
      : null;
  const signalAgeMs =
    inFlight?.lastActivityAtMs !== null && inFlight?.lastActivityAtMs !== undefined
      ? Math.max(0, nowMs - inFlight.lastActivityAtMs)
      : null;

  return (
    <div
      className="border-b border-border/50 px-3 py-2"
      data-pipeline-progress={pipelineKind}
      data-research-progress={pipelineKind === "research" ? "true" : undefined}
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${isDev ? "Dev pipeline" : "Research"} progress`}
        >
          <PipelineIcon
            className={cn("size-3.5 shrink-0", isDev ? "text-amber-400" : "text-violet-400")}
          />
          <span className="shrink-0 text-xs font-medium text-foreground">{pipelineLabel}</span>
          {total > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {completed}/{total}
            </span>
          ) : null}
          {contextTokens != null && contextTokens > 0 ? (
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              title={`${isDev ? "Dev pipeline" : "Research"} context size`}
            >
              · {formatContextWindowTokens(contextTokens)} ctx
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {current ?? (isRunning ? "Working…" : "All stages complete")}
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
      {total > 0 ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              isDev ? "bg-amber-400" : "bg-violet-400",
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      ) : null}
      {/* The plan alone cannot show a rerun. This line names the model actually
          answering right now, which visit it is, and what budget remains. */}
      {delegationList.length > 0 ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {inFlight ? (
            <>
              <LoaderCircle
                className={cn(
                  "size-3 shrink-0 animate-spin",
                  isDev ? "text-amber-400" : "text-violet-400",
                )}
              />
              <span className="min-w-0 truncate text-foreground/80">
                {shortTargetLabel(inFlight.target)}
              </span>
              {inFlight.step ? (
                <span className="shrink-0 tabular-nums">
                  · step {inFlight.step} · visit {inFlight.visit}
                </span>
              ) : null}
              {elapsedMs !== null ? (
                <span className="shrink-0 tabular-nums">
                  · running {formatDelegationElapsed(elapsedMs)}
                </span>
              ) : null}
              {signalAgeMs !== null ? (
                <span
                  className={cn("shrink-0 tabular-nums", signalAgeMs >= 60_000 && "text-amber-500")}
                  title="Time since the latest observable provider event; hidden model reasoning is not visible"
                >
                  · signal{" "}
                  {signalAgeMs < 10_000 ? "now" : `${formatDelegationElapsed(signalAgeMs)} ago`}
                </span>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 truncate">No delegate running</span>
          )}
          <span className="shrink-0 tabular-nums">· {used} sent</span>
          {remainingBudget !== null ? (
            <span
              className={cn("shrink-0 tabular-nums", remainingBudget <= 4 && "text-amber-500")}
              title="Delegations left in this run's budget"
            >
              · {remainingBudget} left
            </span>
          ) : null}
          {failures > 0 ? (
            <span className="shrink-0 tabular-nums text-destructive">· {failures} failed</span>
          ) : null}
        </div>
      ) : null}
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
                {/* Which models answered this step, and on which visit. A
                    reran fact-check reads as "sol ×2" instead of vanishing. */}
                {(() => {
                  const stepNumber = /(\d+)/.exec(step.step)?.[1];
                  const forStep = delegationList.filter(
                    (entry) => stepNumber !== undefined && entry.step.startsWith(stepNumber),
                  );
                  if (forStep.length === 0) return null;
                  const byTarget = new Map<string, { visits: number; failed: number }>();
                  for (const entry of forStep) {
                    const current = byTarget.get(entry.target) ?? { visits: 0, failed: 0 };
                    byTarget.set(entry.target, {
                      visits: Math.max(current.visits, entry.visit),
                      failed: current.failed + (entry.failed ? 1 : 0),
                    });
                  }
                  return (
                    <span className="ml-1.5 opacity-70">
                      {[...byTarget.entries()]
                        .map(
                          ([target, { visits, failed }]) =>
                            `${shortTargetLabel(target)}${visits > 1 ? ` ×${visits}` : ""}${
                              failed > 0 ? " (failed)" : ""
                            }`,
                        )
                        .join(", ")}
                    </span>
                  );
                })()}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {expanded && visitsByStep.size > 0 && remainingBudget !== null && remainingBudget <= 4 ? (
        <p className="mt-1.5 text-[11px] text-amber-500">
          Budget nearly spent. Remaining steps may run with fewer delegates.
        </p>
      ) : null}
    </div>
  );
});
