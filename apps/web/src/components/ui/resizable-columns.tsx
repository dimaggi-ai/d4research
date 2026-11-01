import * as Schema from "effect/Schema";
import { useCallback, useRef, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(value: number, firstMinPx: number, secondMinPx: number, width: number): number {
  if (width <= 0) return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
  const minimum = Math.min(MAX_RATIO, Math.max(MIN_RATIO, firstMinPx / width));
  const maximum = Math.max(MIN_RATIO, Math.min(MAX_RATIO, 1 - secondMinPx / width));
  if (minimum > maximum) return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
  return Math.min(maximum, Math.max(minimum, value));
}

export function ResizableColumns(props: {
  storageKey: string;
  defaultRatio: number;
  first: ReactNode;
  second: ReactNode;
  firstMinPx?: number;
  secondMinPx?: number;
  className?: string;
  separatorLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useLocalStorage(props.storageKey, props.defaultRatio, Schema.Finite);
  const firstMinPx = props.firstMinPx ?? 160;
  const secondMinPx = props.secondMinPx ?? 240;

  const updateFromClientX = useCallback(
    (clientX: number) => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setRatio(
        clampRatio((clientX - bounds.left) / bounds.width, firstMinPx, secondMinPx, bounds.width),
      );
    },
    [firstMinPx, secondMinPx, setRatio],
  );

  return (
    <div
      ref={containerRef}
      className={cn("grid h-full min-h-0 min-w-0", props.className)}
      style={{ gridTemplateColumns: `${ratio * 100}% 5px minmax(0, 1fr)` }}
    >
      {/* The child stretches to the column: a flex item defaults to its content width, which left
          every caller's panel sized to its longest line and clipped instead of reflowing. */}
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">
        {props.first}
      </div>
      <div
        role="separator"
        aria-label={props.separatorLabel ?? "Resize columns"}
        aria-orientation="vertical"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        className="group relative z-10 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateFromClientX(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setRatio((current) =>
            Math.min(
              MAX_RATIO,
              Math.max(MIN_RATIO, current + (event.key === "ArrowLeft" ? -0.025 : 0.025)),
            ),
          );
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:w-0.5 group-hover:bg-primary/50 group-focus-visible:w-0.5 group-focus-visible:bg-primary" />
      </div>
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden [&>*]:min-w-0 [&>*]:flex-1">
        {props.second}
      </div>
    </div>
  );
}
