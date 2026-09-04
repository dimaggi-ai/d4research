import { useAtomValue } from "@effect/atom-react";
import type {
  ServerProvider,
  LegacyServerProviderUsageWindow as ServerProviderUsageWindow,
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
  readonly window: ServerProviderUsageWindow;
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
