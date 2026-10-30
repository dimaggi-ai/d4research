import type { UsageLimitHistoryPoint } from "@d4research/contracts";

export interface HistoryAxisTick {
  /** Milliseconds since the epoch, always inside the chart's range. */
  readonly at: number;
  readonly label: string;
  /** A day boundary carries the heavier rule and the date label. */
  readonly isDayStart: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Ticks for the time axis: day boundaries first, so a reader can tell one day
 * from the next, plus hours inside a range short enough for them to be legible.
 * Over long ranges the day rules thin out to keep the labels from colliding.
 */
export function historyAxisTicks(startMs: number, endMs: number): HistoryAxisTick[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const span = endMs - startMs;
  const ticks: HistoryAxisTick[] = [];

  // About eight date labels fit across the plot before they collide.
  const dayStep = Math.max(1, Math.ceil(span / DAY_MS / 8));
  let dayIndex = 0;
  for (let at = startOfLocalDay(startMs); at <= endMs; at += DAY_MS, dayIndex += 1) {
    if (at < startMs || dayIndex % dayStep !== 0) continue;
    ticks.push({
      at,
      label: new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      isDayStart: true,
    });
  }

  // Hours only help while a day still occupies a readable share of the width.
  if (span <= 2 * DAY_MS) {
    const hourStep = span <= 6 * 60 * 60 * 1000 ? 1 : span <= DAY_MS ? 3 : 6;
    const stepMs = hourStep * 60 * 60 * 1000;
    for (let at = Math.ceil(startMs / stepMs) * stepMs; at <= endMs; at += stepMs) {
      if (ticks.some((tick) => tick.at === at)) continue;
      ticks.push({
        at,
        label: new Date(at).toLocaleTimeString(undefined, { hour: "numeric" }),
        isDayStart: false,
      });
    }
  }

  return ticks.sort((a, b) => a.at - b.at);
}

/** The measurement nearest `at`, for the crosshair and its tooltip. */
export function nearestHistoryPoint(
  points: readonly UsageLimitHistoryPoint[],
  at: number,
): UsageLimitHistoryPoint | null {
  let nearest: UsageLimitHistoryPoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(Date.parse(point.measuredAt) - at);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Measurements grouped by local day, newest day first, newest row first. */
export function historyPointsByDay(
  points: readonly UsageLimitHistoryPoint[],
): Array<{ day: number; label: string; points: UsageLimitHistoryPoint[] }> {
  const days = new Map<number, UsageLimitHistoryPoint[]>();
  for (const point of points) {
    const day = startOfLocalDay(Date.parse(point.measuredAt));
    const bucket = days.get(day);
    if (bucket) bucket.push(point);
    else days.set(day, [point]);
  }
  return [...days]
    .sort(([a], [b]) => b - a)
    .map(([day, dayPoints]) => ({
      day,
      label: new Date(day).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      points: dayPoints.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt)),
    }));
}
