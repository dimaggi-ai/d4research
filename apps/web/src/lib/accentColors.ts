import type { CSSProperties } from "react";

import { resolveAccentHex } from "@d4research/shared/accentColors";
export {
  ACCENT_COLOR_OPTIONS,
  accentColorLabel,
  isAccentColorValue,
  resolveAccentHex,
  type AccentColorOption,
} from "@d4research/shared/accentColors";

const tint = (hex: string, percent: number) =>
  `color-mix(in srgb, ${hex} ${percent}%, transparent)`;

/**
 * The colour is strongest at the edge and gives way to whatever the row already sits on, so the
 * tail reads as the surface darkening rather than as a second colour painted over it.
 */
function edgeGradient(hex: string, direction: "to right" | "to left", strength: number): string {
  return [
    `linear-gradient(${direction},`,
    `${tint(hex, strength)} 0%,`,
    `${tint(hex, strength * 0.55)} 9%,`,
    `${tint(hex, strength * 0.22)} 18%,`,
    `transparent 29%)`,
  ].join(" ");
}

/**
 * Background layers for a thread card: its own colour enters from the left, its project's from the
 * right, and either may be absent. The layers go on `background-image`, which paints above the
 * row's background colour and below its content, so no extra element is needed.
 */
export function threadCardAccentStyle(input: {
  readonly threadColor: string | null | undefined;
  readonly projectColor: string | null | undefined;
}): CSSProperties | undefined {
  const leading = resolveAccentHex(input.threadColor);
  const trailing = resolveAccentHex(input.projectColor);
  if (leading === null && trailing === null) return undefined;

  const layers = [
    ...(leading === null ? [] : [edgeGradient(leading, "to right", 34)]),
    ...(trailing === null ? [] : [edgeGradient(trailing, "to left", 26)]),
  ];
  return {
    backgroundImage: layers.join(", "),
    // An inset rule rather than a border width, so a coloured card keeps the same box as a plain one.
    ...(leading === null ? {} : { boxShadow: `inset 2px 0 0 0 ${tint(leading, 72)}` }),
  };
}

/**
 * The same colour as a quiet wash across a project row in the scope menu. Background only: these
 * rows keep their own focus ring, and an inline box-shadow would paint over it.
 */
export function projectAccentStyle(color: string | null | undefined): CSSProperties | undefined {
  const hex = resolveAccentHex(color);
  if (hex === null) return undefined;
  return {
    backgroundImage: `linear-gradient(to right, ${tint(hex, 24)} 0%, ${tint(hex, 10)} 45%, transparent 88%)`,
  };
}
