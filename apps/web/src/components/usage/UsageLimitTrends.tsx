import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageLimitHistoryInput } from "@d4research/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useMemo, useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { UsageLimitTrendRows } from "./UsageLimitTrendRows";

function EnvironmentTrends({
  environmentId,
  label,
  days,
}: {
  environmentId: EnvironmentId;
  label: string;
  days: UsageLimitHistoryInput["days"];
}) {
  const query = useMemo(
    () => serverEnvironment.usageLimitHistory({ environmentId, input: { days } }),
    [environmentId, days],
  );
  const result = useAtomValue(query);
  const history = Option.getOrNull(AsyncResult.value(result));
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") appAtomRegistry.refresh(query);
    }, 30_000);
    return () => clearInterval(timer);
  }, [query]);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={result.waiting}
          onClick={() => appAtomRegistry.refresh(query)}
        >
          Refresh history
        </Button>
      </div>
      {result._tag === "Failure" ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load history. The environment may be offline or need an update.
        </p>
      ) : null}
      {!history && result.waiting ? (
        <p className="text-sm text-muted-foreground">Loading history…</p>
      ) : null}
      {history && history.points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No measurements in this period yet. History starts after installing this version and
          receiving fresh provider limits.
        </p>
      ) : null}
      {history?.truncated ? (
        <p role="status" className="text-sm text-muted-foreground">
          Showing the latest 20,000 points. Choose a shorter period for more detail.
        </p>
      ) : null}
      {history ? <UsageLimitTrendRows history={history} /> : null}
    </section>
  );
}

export function UsageLimitTrends({
  environments,
}: {
  environments: readonly { environmentId: EnvironmentId; label: string }[];
}) {
  const [days, setDays] = useState<UsageLimitHistoryInput["days"]>(1);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2" aria-label="History period">
        {([1, 7, 30, 90] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={days === value ? "secondary" : "ghost"}
            aria-pressed={days === value}
            onClick={() => setDays(value)}
          >
            {value === 1 ? "24 hours" : `${value} days`}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Remaining quota over time. Each account and quota window is shown separately.
      </p>
      {environments.map((environment) => (
        <EnvironmentTrends key={environment.environmentId} {...environment} days={days} />
      ))}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">About history</summary>
        <p className="mt-2">
          History shows remaining quota, not token counts. Active providers are checked at work
          start, about every 30 seconds, and when their last working thread finishes. Measurements
          are stored for 90 days in 30-second buckets; longer ranges are downsampled. History cannot
          be backfilled.
        </p>
      </details>
    </div>
  );
}
