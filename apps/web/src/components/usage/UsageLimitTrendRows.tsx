import type { UsageLimitHistory, UsageLimitHistoryPoint } from "@d4research/contracts";
import { formatAgo, formatResetAt } from "@d4research/shared/limitsFormat";
import {
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "../../lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { historyProviderGroups, historySegments } from "./usageLimitHistoryModel";
import { historyAxisTicks, historyPointsByDay, nearestHistoryPoint } from "./usageLimitHistoryAxis";

const PLOT_WIDTH = 570;
const PLOT_HEIGHT = 56;
const PLOT_TOP = 4;
const PLOT_BOTTOM = 52;

const pointY = (point: UsageLimitHistoryPoint) =>
  PLOT_TOP +
  ((100 - Math.min(100, Math.max(0, point.remainingPercent))) / 100) * (PLOT_BOTTOM - PLOT_TOP);

function pointX(point: UsageLimitHistoryPoint, start: number, span: number) {
  return 2 + ((Date.parse(point.measuredAt) - start) / span) * (PLOT_WIDTH - 4);
}

function trendDrawing(points: readonly UsageLimitHistoryPoint[], history: UsageLimitHistory) {
  const start = Date.parse(history.since);
  const end = Date.parse(history.readAt);
  const resolutionMinutes = history.resolutionMinutes;
  const span = Math.max(1, end - start);
  const coordinates = (segment: readonly UsageLimitHistoryPoint[]) =>
    segment.map((point) => `${pointX(point, start, span)},${pointY(point)}`).join(" ");
  return {
    start,
    end,
    span,
    bridge: coordinates(points),
    segments: historySegments(points, resolutionMinutes).map((segment) => ({
      key: segment[0]!.measuredAt,
      coordinates: coordinates(segment),
      isolated: segment.length === 1 ? segment[0]! : null,
    })),
    days: historyAxisTicks(start, end).filter((tick) => tick.isDayStart),
  };
}

function TrendChart({
  points,
  history,
  color,
}: {
  points: readonly UsageLimitHistoryPoint[];
  history: UsageLimitHistory;
  color: string;
}) {
  const drawing = useMemo(() => trendDrawing(points, history), [points, history]);
  const { start, end, span } = drawing;
  const latest = points.at(-1)!;
  const reset = formatResetAt(latest.resetsAt, end);
  const [hovered, setHovered] = useState<UsageLimitHistoryPoint | null>(null);
  const [expanded, setExpanded] = useState(false);
  const measurementDays = useMemo(
    () => (expanded ? historyPointsByDay(points.slice(-100)) : []),
    [points, expanded],
  );
  const axisDate = (at: number) =>
    new Date(at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setHovered(nearestHistoryPoint(points, start + ratio * span));
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <strong
            className={cn(
              "text-lg font-medium tracking-tight",
              latest.remainingPercent <= 0
                ? "text-error"
                : latest.remainingPercent < 20
                  ? "text-warning-foreground"
                  : undefined,
            )}
          >
            {latest.remainingPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%
          </strong>
          <span className="text-3xs text-muted-foreground">remaining</span>
        </span>
        {reset ? (
          <span className="text-3xs text-muted-foreground">
            {reset === "now" ? "Reset due" : `Resets ${reset}`}
          </span>
        ) : null}
      </div>
      <div
        data-usage-limit-chart
        className="relative mt-1 h-14 rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        role="group"
        tabIndex={0}
        aria-label={`${latest.windowLabel}: remaining quota over time. Latest ${latest.remainingPercent.toFixed(1)} percent. Use left and right arrows to inspect measurements.`}
        onPointerMove={trackPointer}
        onPointerDown={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          trackPointer(event);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setHovered(null);
        }}
        onFocus={() => setHovered(latest)}
        onBlur={() => setHovered(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setHovered(null);
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = hovered ? Math.max(0, points.indexOf(hovered)) : points.length - 1;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? points.length - 1
                : Math.min(
                    points.length - 1,
                    Math.max(0, index + (event.key === "ArrowLeft" ? -1 : 1)),
                  );
          setHovered(points[next] ?? latest);
        }}
      >
        <svg
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden
        >
          <line
            x1={2}
            x2={PLOT_WIDTH - 2}
            y1={PLOT_BOTTOM}
            y2={PLOT_BOTTOM}
            stroke="currentColor"
            className="text-border"
            vectorEffect="non-scaling-stroke"
          />
          {drawing.days.map((tick) => {
            const at = 2 + ((tick.at - start) / span) * (PLOT_WIDTH - 4);
            return (
              <line
                key={tick.at}
                x1={at}
                x2={at}
                y1={PLOT_TOP}
                y2={PLOT_BOTTOM}
                stroke="currentColor"
                strokeDasharray="2 4"
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          <polyline
            points={drawing.bridge}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
          />
          {drawing.segments.map((segment) => (
            <g key={segment.key}>
              <polyline
                points={segment.coordinates}
                fill="none"
                stroke={color}
                strokeWidth="1.6"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {segment.isolated ? (
                <circle
                  cx={pointX(segment.isolated, start, span)}
                  cy={pointY(segment.isolated)}
                  r={2}
                  fill={color}
                  stroke={color}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          ))}
          <circle
            cx={pointX(latest, start, span)}
            cy={pointY(latest)}
            r={2}
            fill={color}
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {hovered ? (
            <g>
              <line
                x1={pointX(hovered, start, span)}
                x2={pointX(hovered, start, span)}
                y1={PLOT_TOP}
                y2={PLOT_BOTTOM}
                stroke="currentColor"
                strokeDasharray="3 3"
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={pointX(hovered, start, span)}
                cy={pointY(hovered)}
                r={3}
                fill={color}
                stroke={color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
        </svg>
        {hovered ? (
          <div
            role="status"
            className="pointer-events-none absolute top-0 left-0 z-10 w-max max-w-full rounded-md border border-border bg-popover px-2 py-1 text-3xs text-popover-foreground shadow-md"
          >
            <span className="block tabular-nums">
              {hovered.remainingPercent.toFixed(1)}% remaining
            </span>
            <span className="block text-muted-foreground">
              {new Date(hovered.measuredAt).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        ) : null}
      </div>
      <div className="mt-0.5 grid grid-cols-2 gap-1 text-3xs text-muted-foreground" aria-hidden>
        <span className="truncate">{axisDate(start)}</span>
        <span className="truncate text-right">{axisDate(end)}</span>
      </div>
      <details
        className="mt-2 text-3xs"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">
          Measured {formatAgo(latest.measuredAt, end)} · details
        </summary>
        {expanded ? (
          <div className="mt-2">
            <p className="mb-2 text-muted-foreground">
              Last measured {new Date(latest.measuredAt).toLocaleString()}
            </p>
            <p className="mb-2 text-muted-foreground">
              Measurements ({points.length > 100 ? "latest 100" : points.length})
            </p>
            <div className="max-h-48 overflow-auto">
              <table className="w-full text-left tabular-nums">
                <thead>
                  <tr>
                    <th scope="col">Measured</th>
                    <th scope="col">Remaining</th>
                  </tr>
                </thead>
                {measurementDays.map((day) => (
                  <tbody key={day.day}>
                    <tr>
                      <th
                        colSpan={2}
                        className="pt-2 text-left font-medium text-muted-foreground"
                        scope="colgroup"
                      >
                        {day.label}
                      </th>
                    </tr>
                    {day.points.map((point) => (
                      <tr key={point.measuredAt}>
                        <td>
                          {new Date(point.measuredAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td>{point.remainingPercent.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </div>
        ) : null}
      </details>
    </div>
  );
}

function AdditionalLimits({
  windows,
  history,
  color,
}: {
  windows: readonly (readonly [string, readonly UsageLimitHistoryPoint[]])[];
  history: UsageLimitHistory;
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="col-span-full border-t border-border/60 pt-2"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-3xs text-muted-foreground">
        Additional limits ·{" "}
        {windows
          .map(
            ([, points]) =>
              `${points.at(-1)!.windowLabel}: ${points.at(-1)!.remainingPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% remaining`,
          )
          .join(" · ")}
      </summary>
      {expanded ? (
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {windows.map(([windowId, points]) => (
            <div key={windowId} className="min-w-0">
              <h5 className="mb-1 text-xs">{points.at(-1)!.windowLabel}</h5>
              <TrendChart points={points} history={history} color={color} />
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function windowRank(id: string) {
  return id === "five_hour" || id === "primary"
    ? 0
    : id === "seven_day" || id === "secondary"
      ? 1
      : 2;
}

/** Independent account rows: percentages from different subscriptions are never pooled. */
export function UsageLimitTrendRows({ history }: { history: UsageLimitHistory }) {
  const groups = useMemo(() => historyProviderGroups(history.points), [history.points]);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const windows = new Map(
          group.accounts.flatMap(([, account]) =>
            [...account.windows].map(([id, points]) => [id, points.at(-1)!.windowLabel] as const),
          ),
        );
        const columns = [...windows]
          .sort(([a], [b]) => windowRank(a) - windowRank(b) || a.localeCompare(b))
          .slice(0, 2);
        const primaryIds = new Set(columns.map(([id]) => id));
        const gridStyle = {
          "--trend-columns": `minmax(10rem, 1fr) repeat(${columns.length}, minmax(0, 1fr))`,
        } as CSSProperties;
        const gridClass = cn(
          "grid gap-x-5 gap-y-3 @[44rem]:grid-cols-(--trend-columns)",
          columns.length > 1 ? "grid-cols-2" : "grid-cols-1",
        );
        const ProviderIcon =
          group.label === "Claude" ? ClaudeAI : group.label === "Codex" ? OpenAI : null;
        const defaultColor =
          group.label === "Claude"
            ? "#d97757"
            : group.label === "Codex"
              ? "#7ed3be"
              : "var(--primary)";
        return (
          <section
            key={group.label}
            className="@container min-w-0"
            aria-label={`${group.label} usage trends`}
          >
            <div className="mb-3 flex items-center gap-2.5">
              {ProviderIcon ? (
                <span
                  className="flex size-7 items-center justify-center rounded-lg border border-border bg-card"
                  style={{ color: defaultColor }}
                >
                  <ProviderIcon className="size-4" aria-hidden />
                </span>
              ) : null}
              <h4 className="text-sm font-semibold">{group.label}</h4>
              <span className="text-xs text-muted-foreground">
                {group.accounts.length} {group.accounts.length === 1 ? "account" : "accounts"}
              </span>
              <span className="ml-1 h-px flex-1 bg-border" aria-hidden />
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div
                className="hidden border-b border-border bg-muted/30 px-4 py-2 text-3xs text-muted-foreground @[44rem]:grid @[44rem]:grid-cols-(--trend-columns) @[44rem]:gap-x-5"
                style={gridStyle}
                aria-hidden
              >
                <span>Account</span>
                {columns.map(([id, label]) => (
                  <span key={id}>{label} · remaining</span>
                ))}
              </div>
              {group.accounts.map(([id, account]) => {
                const extra = [...account.windows]
                  .filter(([windowId]) => !primaryIds.has(windowId))
                  .sort(([a], [b]) => a.localeCompare(b));
                return (
                  <article
                    key={id}
                    className={cn(gridClass, "border-b border-border px-4 py-3.5 last:border-b-0")}
                    style={gridStyle}
                  >
                    <div
                      className={cn(
                        "min-w-0 @[44rem]:col-span-1",
                        columns.length > 1 ? "col-span-2" : undefined,
                      )}
                    >
                      <h5 className="flex min-w-0 items-start gap-2 text-xs font-medium">
                        <span
                          className="mt-1 size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: account.color ?? defaultColor }}
                          aria-hidden
                        />
                        {account.label.includes("@") ? (
                          <RedactedSensitiveText
                            value={account.label}
                            ariaLabel="Toggle account label visibility"
                            revealTooltip="Click to reveal account"
                            hideTooltip="Click to hide account"
                            className="break-all whitespace-normal text-left"
                          />
                        ) : (
                          <span className="break-words">{account.label}</span>
                        )}
                      </h5>
                      {extra.length ? (
                        <p className="mt-2 pl-4 text-3xs text-muted-foreground">
                          {extra.length} additional {extra.length === 1 ? "limit" : "limits"} below
                        </p>
                      ) : null}
                    </div>
                    {columns.map(([windowId, label]) => {
                      const points = account.windows.get(windowId);
                      return (
                        <div key={windowId} className="min-w-0">
                          <p className="mb-1 text-3xs text-muted-foreground @[44rem]:hidden">
                            {points?.at(-1)?.windowLabel ?? label}
                          </p>
                          {points?.length ? (
                            <TrendChart
                              points={points}
                              history={history}
                              color={account.color ?? defaultColor}
                            />
                          ) : (
                            <p className="text-xs text-muted-foreground">No measurements</p>
                          )}
                        </div>
                      );
                    })}
                    {extra.length ? (
                      <AdditionalLimits
                        windows={extra}
                        history={history}
                        color={account.color ?? defaultColor}
                      />
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
      {groups.length ? (
        <p className="text-3xs text-muted-foreground">
          Solid lines connect measurements, including resets. Dashed lines span gaps. Vertical
          guides mark local midnight. Hover, tap, or use the arrow keys to inspect a graph.
        </p>
      ) : null}
    </div>
  );
}
