import { useEffect, useState } from "react";

const TICK_INTERVAL_MS = 120;
const FADE_OUT_DELAY_MS = 220;
const SEED_PERCENT = 4;
const ASYMPTOTE_PERCENT = 90;
const APPROACH_FACTOR = 0.08;
const MIN_INCREMENT = 0.5;

/**
 * Indeterminate progress simulator for the preview chrome's loading bar.
 * Animates 0 → 90% asymptotically while `loading` is true, snaps to 100%
 * on release, then resets after a short pause.
 */
export function useLoadingProgress(loading: boolean): number {
  const [progress, setProgress] = useState(loading ? SEED_PERCENT : 0);
  const [wasLoading, setWasLoading] = useState(loading);
  if (wasLoading !== loading) {
    setWasLoading(loading);
    setProgress(
      loading
        ? progress > 0 && progress < 95
          ? progress
          : SEED_PERCENT
        : progress === 0
          ? 0
          : 100,
    );
  }

  useEffect(() => {
    if (!loading) {
      const timer = window.setTimeout(() => setProgress(0), FADE_OUT_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    const interval = window.setInterval(() => {
      setProgress((current) => {
        if (current >= ASYMPTOTE_PERCENT) return current;
        const remaining = ASYMPTOTE_PERCENT - current;
        return Math.min(
          ASYMPTOTE_PERCENT,
          current + Math.max(MIN_INCREMENT, remaining * APPROACH_FACTOR),
        );
      });
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loading]);

  return progress;
}
