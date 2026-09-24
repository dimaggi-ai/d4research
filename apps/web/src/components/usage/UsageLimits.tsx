import { type EnvironmentId } from "@d4research/contracts";
import { type ProviderConsumeResetCreditOutcome } from "@d4research/contracts";
import { ProviderConsumeResetCreditInput } from "@d4research/contracts";
import { ServerProviderResetCredits } from "@d4research/contracts";
import { elapsedShare } from "@d4research/shared/usageLimits";
import { formatDuration } from "@d4research/shared/usageLimits";
import { formatResetsIn } from "@d4research/shared/usageLimits";
import { type LimitPace } from "@d4research/shared/usageLimits";
import { paceOf } from "@d4research/shared/usageLimits";
import { remainingPercent } from "@d4research/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { TrendingDownIcon } from "lucide-react";
import { TrendingUpIcon } from "lucide-react";
import { Fragment } from "react";
import { useState } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { AlertDialog } from "../ui/alert-dialog";
import { AlertDialogClose } from "../ui/alert-dialog";
import { AlertDialogDescription } from "../ui/alert-dialog";
import { AlertDialogFooter } from "../ui/alert-dialog";
import { AlertDialogHeader } from "../ui/alert-dialog";
import { AlertDialogPopup } from "../ui/alert-dialog";
import { AlertDialogTitle } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { TooltipPopup } from "../ui/tooltip";
import { TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { useAtomValue } from "@effect/atom-react";
import type {
  ServerProvider,
  LegacyServerProviderUsageWindow,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@d4research/contracts";
import { useMemo } from "react";

import { formatDateTimeShort } from "@d4research/shared/usageFormat";

import { primaryServerProvidersAtom } from "../../state/server";
import { PROVIDER_COLOR, PROVIDER_MARK } from "./usageProviders";

export interface ProviderLimitWindow {
  readonly key: string;
  readonly providerLabel: string;
  /** Set only for the harnesses the usage charts already colour. */
  readonly providerKind: UsageProviderKind | null;
  readonly planType: string | null;
  readonly window: LegacyServerProviderUsageWindow;
}

const CHARTED_PROVIDERS = new Set<string>(["claude", "codex"]);

/**
 * One row per reported window, flattened across providers. A provider whose
 * usage probe never answered carries no windows and drops out here instead of
 * rendering an empty card.
 */
export function selectProviderLimitWindows(
  providers: readonly ServerProvider[],
): readonly ProviderLimitWindow[] {
  return providers.flatMap((provider) => {
    const usage = provider.usage;
    if (usage === undefined || usage.support !== "supported") return [];
    return usage.windows.map((window) => ({
      key: `${provider.instanceId}:${window.id}`,
      providerLabel: provider.displayName ?? provider.driver,
      providerKind: CHARTED_PROVIDERS.has(provider.driver)
        ? (provider.driver as UsageProviderKind)
        : null,
      planType: usage.planType,
      window,
    }));
  });
}

/** Providers may report a window without a reset stamp; say so rather than guess. */
export function formatLimitReset(resetsAt: string | null, planType: string | null): string {
  const reset =
    resetsAt !== null && !Number.isNaN(Date.parse(resetsAt))
      ? `Resets ${formatDateTimeShort(resetsAt)}`
      : "Reset time unavailable";
  return planType === null ? reset : `${planType} · ${reset}`;
}

/**
 * Account rate limits as the providers themselves report them, alongside the
 * spend the rest of the page derives from transcripts. Renders nothing when no
 * connected provider exposes a window.
 */
export function UsageLimits() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const rows = useMemo(() => selectProviderLimitWindows(providers), [providers]);
  return <UsageLimitsView rows={rows} />;
}

/** The presentation half, split out so it renders without the atom registry. */
export function UsageLimitsView({ rows }: { readonly rows: readonly ProviderLimitWindow[] }) {
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Limits</h2>
        <span className="text-xs text-muted-foreground">Reported by each provider account</span>
      </div>
      <div className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-4">
        {rows.map((row) => (
          <LimitWindow key={row.key} row={row} />
        ))}
      </div>
    </section>
  );
}

function LimitWindow({ row }: { readonly row: ProviderLimitWindow }) {
  const percent = row.window.utilizationPercent;
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const Mark = row.providerKind === null ? null : PROVIDER_MARK[row.providerKind];
  return (
    <div className="flex flex-col gap-1.5 bg-background px-4 py-3">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {Mark === null ? null : <Mark className="size-3.5 shrink-0" aria-hidden />}
        {row.providerLabel} · {row.window.label}
      </span>
      <span className="text-lg text-foreground tabular-nums">
        {percent === null ? "—" : `${Math.round(percent)}%`}
      </span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full"
          style={{
            width: `${filled.toFixed(1)}%`,
            backgroundColor:
              row.providerKind === null
                ? "var(--color-foreground)"
                : PROVIDER_COLOR[row.providerKind],
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {formatLimitReset(row.window.resetsAt, row.planType)}
      </span>
    </div>
  );
}

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** The series colour the cost chart uses for this driver, so the two views read as one. */
export function barColor(driver: ServerProvider["driver"]): string {
  const kind: UsageProviderKind | undefined =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
  return kind ? PROVIDER_PRESENTATION[kind].color : "var(--foreground)";
}

/** Pace as a glyph with the words on hover. */
export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * The fill is the share of quota spent; the hairline is how far into the
 * window the clock is, which is also where even spending would have put the
 * fill. Hover for the exact figures and reset time.
 */
function WindowBar({
  color,
  window,
  now,
}: {
  readonly color: string;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  // The fill is quota left, so the even-spending mark is the time left.
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  const summary = `${window.label}: ${remaining}% left${
    timeLeft === null ? "" : `, ${timeLeft}% of the window left`
  }${resetsIn ? `, ${resetsIn}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {remaining > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
        ) : null}
        {timeLeft !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${timeLeft}%` }}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {remaining}% left{timeLeft !== null ? ` · ${timeLeft}% of the window left` : ""}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One account's windows as rows: label and percent, bar, pace and countdown.
 * Compact rows fit the composer panel with narrower columns.
 */
export function LimitWindows({
  driver,
  windows,
  now,
  compact = false,
}: {
  readonly driver: ServerProvider["driver"];
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const color = barColor(driver);
  return (
    <div
      className={
        compact
          ? "grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-0.5"
          : "grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1"
      }
    >
      {windows.map((window) => {
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {remainingPercent(window)}% left
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{resetsIn ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/** Everything a redeem needs: where to send it and what to say afterwards. */
export function useResetCredit(
  environmentId: EnvironmentId,
  input: ProviderConsumeResetCreditInput,
) {
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    setStatus(
      "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not use the reset credit.",
    );
  };

  return { confirming, setConfirming, busy, status, redeem };
}

/**
 * The confirm for a redeem. Redeeming spends a credit the provider granted the
 * user, so it never fires on a bare click. Mount it outside any popover that
 * holds the button: dialogs stack under popovers, and closing the popover
 * would unmount a dialog rendered inside it.
 */
export function ResetCreditDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset credit?</AlertDialogTitle>
          <AlertDialogDescription>
            This redeems one credit on your account and clears the current rate-limit windows. It
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={onConfirm}>Use credit</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** `2 reset credits banked · next expires in 27d 23h`, or the short form for a popover. */
export function resetCreditsSummary(
  credits: ServerProviderResetCredits,
  now: number,
  compact = false,
): string {
  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  if (credits.availableCount === 0) return "No reset credits banked";
  if (compact)
    return `${credits.availableCount} banked${expiresIn ? ` · expires in ${expiresIn}` : ""}`;
  return `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
    expiresIn ? ` · next expires in ${expiresIn}` : ""
  }`;
}

/** Banked reset credits with the redeem button and its confirm, self-contained. */
export function ResetCredits({
  environmentId,
  input,
  credits,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
}) {
  const { confirming, setConfirming, busy, status, redeem } = useResetCredit(environmentId, input);
  if (credits.availableCount === 0 && status === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{resetCreditsSummary(credits, now)}</span>
      {credits.availableCount > 0 ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
          {busy ? "Using…" : "Use reset"}
        </Button>
      ) : null}
      {status ? <span className="text-foreground">{status}</span> : null}
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void redeem()}
      />
    </div>
  );
}

/**
 * Subscription quota across every connected environment's providers and hubs,
 * pooled per provider. The page advances `now` on explicit refresh rather than
 * ticking: a live clock would repaint the page for no decision-changing gain.
 */
export function UsageLimitsSection({
  selectedEnvironmentIds,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  return <UsageLimitsPooled presentations={selected} now={now} />;
}
