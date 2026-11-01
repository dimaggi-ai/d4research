export interface AccentColorOption {
  readonly id: string;
  readonly label: string;
  readonly hex: string;
}

/**
 * Ten muted mid-tones. They are deliberately desaturated: an accent marks a card at a glance
 * without competing with the status colors the row already uses for PR state and diff counts.
 */
export const ACCENT_COLOR_OPTIONS: ReadonlyArray<AccentColorOption> = [
  { id: "slate", label: "Slate", hex: "#6b7a8f" },
  { id: "red", label: "Red", hex: "#b25a52" },
  { id: "orange", label: "Orange", hex: "#b2794a" },
  { id: "amber", label: "Amber", hex: "#a8913f" },
  { id: "green", label: "Green", hex: "#5f9464" },
  { id: "teal", label: "Teal", hex: "#4e938c" },
  { id: "cyan", label: "Cyan", hex: "#4d8aa0" },
  { id: "blue", label: "Blue", hex: "#5b7fb8" },
  { id: "violet", label: "Violet", hex: "#8069b5" },
  { id: "pink", label: "Pink", hex: "#ab5f92" },
];

const OPTION_BY_ID = new Map(ACCENT_COLOR_OPTIONS.map((option) => [option.id, option]));

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * An accent is stored either as a palette id or as a literal `#rrggbb`, so a project can carry a
 * colour the palette does not offer without a second field to keep in sync.
 */
export function resolveAccentHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const option = OPTION_BY_ID.get(value);
  if (option) return option.hex;
  return HEX_PATTERN.test(value) ? value : null;
}

export function accentColorLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return OPTION_BY_ID.get(value)?.label ?? (HEX_PATTERN.test(value) ? value.toUpperCase() : null);
}

export function isAccentColorValue(value: string): boolean {
  return OPTION_BY_ID.has(value) || HEX_PATTERN.test(value);
}
