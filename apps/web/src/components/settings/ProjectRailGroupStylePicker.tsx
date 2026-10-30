import "../sidebar/projectRail.css";

import type { ProjectRailGroupStyle } from "@d4research/contracts";

import { cn } from "~/lib/utils";

const STYLES: ReadonlyArray<{
  readonly value: ProjectRailGroupStyle;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "edge",
    label: "Edge",
    description: "A colored edge inside the label runs on as a line along the group's projects.",
  },
  {
    value: "well",
    label: "Well",
    description: "The label and its projects sit together in one softly tinted box.",
  },
  {
    value: "outline",
    label: "Outline",
    description:
      "A thin outline in the group color wraps the projects, with the name set into the top border.",
  },
  {
    value: "label",
    label: "Label",
    description: "Only the name carries the color. A hairline closes each group.",
  },
  {
    value: "solid",
    label: "Solid",
    description: "A filled name tag in the group color, with the projects on a faint tint of it.",
  },
];

const PREVIEW_TILE_COLORS = ["#6366f1", "#f97316"] as const;

function GroupStylePreview({ style }: { style: ProjectRailGroupStyle }) {
  return (
    <div
      aria-hidden="true"
      data-group-style={style}
      data-rail-root=""
      className="pointer-events-none flex w-13 flex-col items-center gap-1 rounded-md border border-sidebar-border bg-sidebar py-2"
    >
      <div data-rail="ga" data-rail-group-color="blue" data-collapsed="false">
        <span data-rail="ga-chip">
          <span data-rail="ga-name">Work</span>
        </span>
        <div data-rail="body">
          <div data-rail="ga-inner">
            {PREVIEW_TILE_COLORS.map((color) => (
              <span
                key={color}
                data-rail="item"
                className="grid size-9 place-items-center rounded-md border border-transparent"
              >
                <span className="size-4.5 rounded-sm" style={{ backgroundColor: color }} />
              </span>
            ))}
          </div>
        </div>
      </div>
      <div data-rail="ga" data-rail-group-color="green" data-collapsed="true">
        <span data-rail="ga-chip">
          <span data-rail="ga-name">Home</span>
          <span data-rail="ga-count">3</span>
        </span>
      </div>
    </div>
  );
}

export function ProjectRailGroupStylePicker({
  value,
  onChange,
}: {
  value: ProjectRailGroupStyle;
  onChange: (style: ProjectRailGroupStyle) => void;
}) {
  const selected = STYLES.find((style) => style.value === value) ?? STYLES[0]!;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label="Project group style"
        className="grid grid-cols-3 gap-2 sm:grid-cols-5"
      >
        {STYLES.map((style) => (
          <button
            key={style.value}
            type="button"
            role="radio"
            aria-checked={value === style.value}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              value === style.value ? "border-primary bg-accent" : "border-border",
            )}
            onClick={() => onChange(style.value)}
          >
            <GroupStylePreview style={style.value} />
            {style.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{selected.description}</p>
    </div>
  );
}
