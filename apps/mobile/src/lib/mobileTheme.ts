import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  getThemeColorsForAppearance,
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS as SHARED_MOBILE_THEME_IDS,
  type MobileThemeId as SharedMobileThemeId,
  type ThemeAppearance,
  type ThemeColors,
} from "@d4research/shared/themePalettes";
import {
  STANDARD_THEME_PREVIEW_COLORS,
  type ThemePreviewColors,
} from "@d4research/shared/themePreview";

/** The T3 Code palette, rendered by the plain uniwind `light` and `dark` variants. */
export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;
export const DIMAGGI_MOBILE_THEME_ID = "dimaggi";
/** The theme a fresh install, or an unknown stored theme id, starts with. */
export const INITIAL_MOBILE_THEME_ID = DIMAGGI_MOBILE_THEME_ID;
/** Themes rendered as named `${id}-light|dark` uniwind variants. */
export const MOBILE_PALETTE_THEME_IDS = [...BUILT_IN_THEME_IDS, DIMAGGI_MOBILE_THEME_ID] as const;
export type MobilePaletteThemeId = (typeof MOBILE_PALETTE_THEME_IDS)[number];
export const MOBILE_THEME_IDS = [
  ...SHARED_MOBILE_THEME_IDS,
  "material-you",
  DIMAGGI_MOBILE_THEME_ID,
] as const;
type MobileColorThemeId = SharedMobileThemeId | typeof DIMAGGI_MOBILE_THEME_ID;
export type MobileThemeId = MobileColorThemeId | "material-you";
export type MobileThemeAppearance = ThemeAppearance;
export type MobileThemeMode = MobileThemeAppearance | "system";
export type MobileThemeIds = Readonly<Record<MobileThemeAppearance, MobileThemeId>>;

export const MOBILE_THEME_OPTIONS: ReadonlyArray<{
  readonly id: MobileThemeId;
  readonly label: string;
}> = [
  { id: DIMAGGI_MOBILE_THEME_ID, label: "DIMAGGI" },
  { id: DEFAULT_MOBILE_THEME_ID, label: "T3 Code" },
  { id: "material-you", label: "Material You" },
  ...BUILT_IN_THEMES.map((theme) => ({ id: theme.id as MobileThemeId, label: theme.label })),
];

export type MobileThemeVariable = keyof ReturnType<typeof createMobileThemeVariables>;
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>;

function normalizeMobileThemeId(value: unknown): MobileThemeId {
  return typeof value === "string" && (MOBILE_THEME_IDS as readonly string[]).includes(value)
    ? (value as MobileThemeId)
    : INITIAL_MOBILE_THEME_ID;
}

export function normalizeMobileThemeMode(value: unknown): MobileThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveMobileThemeIds(preferences: {
  readonly themeId?: unknown;
  readonly lightThemeId?: unknown;
  readonly darkThemeId?: unknown;
}): MobileThemeIds {
  const legacyThemeId = normalizeMobileThemeId(preferences.themeId);
  return {
    light:
      preferences.lightThemeId === undefined
        ? legacyThemeId
        : normalizeMobileThemeId(preferences.lightThemeId),
    dark:
      preferences.darkThemeId === undefined
        ? legacyThemeId
        : normalizeMobileThemeId(preferences.darkThemeId),
  };
}

export function createMobileThemeSelectionPatch(
  themeIds: MobileThemeIds,
  activeAppearance: MobileThemeAppearance,
  selectedAppearance: MobileThemeAppearance,
  value: MobileThemeId,
) {
  const nextThemeIds: MobileThemeIds = {
    light: selectedAppearance === "light" ? value : themeIds.light,
    dark: selectedAppearance === "dark" ? value : themeIds.dark,
  };
  return {
    lightThemeId: nextThemeIds.light,
    darkThemeId: nextThemeIds.dark,
    themeId: nextThemeIds[activeAppearance],
  };
}

export function createMobileThemePairPatch(value: MobileThemeId) {
  return {
    lightThemeId: value,
    darkThemeId: value,
    themeId: value,
  };
}

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/;

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

function oklabToLinearSrgb(lightness: number, a: number, b: number) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
}

function oklabToSrgb(lightness: number, a: number, b: number) {
  const [red, green, blue] = oklabToLinearSrgb(lightness, a, b);
  return [linearToSrgb(red), linearToSrgb(green), linearToSrgb(blue)] as const;
}

/** React Native does not accept OKLCH ColorValues, so palettes cross the app boundary as sRGB. */
export function themeColorToNativeColor(value: string): string {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return value;

  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const [red, green, blue] = oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));

  return alpha < 1
    ? `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(4))})`
    : `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function nativeColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(
    Object.entries(colors).map(([role, color]) => [role, themeColorToNativeColor(color)]),
  ) as ThemeColors;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6) return color;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbChannels(color: string): readonly [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color);
  if (!match) return null;
  const [, red = "0", green = "0", blue = "0"] = match;
  return [Number.parseInt(red, 16), Number.parseInt(green, 16), Number.parseInt(blue, 16)];
}

/** Native chips require opaque hex; flatten translucent roles. */
export function flattenThemeColor(color: string, surface: string): string {
  const alphaHex = /^#([\da-f]{6})([\da-f]{2})$/i.exec(color);
  if (alphaHex) {
    const channels = rgbChannels(color)!;
    return flattenThemeColor(
      `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Number.parseInt(alphaHex[2]!, 16) / 255})`,
      surface,
    );
  }
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(
    color.trim(),
  );
  if (!match) return color;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const behind = rgbChannels(surface) ?? [0, 0, 0];
  const channels = [match[1], match[2], match[3]].map((channel, index) =>
    Math.max(0, Math.min(255, Math.round(Number(channel) * alpha + behind[index]! * (1 - alpha)))),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbToOklab(channels: readonly [number, number, number]) {
  const [red = 0, green = 0, blue = 0] = channels.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ] as const;
}

function relativeLuminance(channels: readonly [number, number, number]): number {
  const [red, green, blue] = channels.map(srgbToLinear);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

export function isDarkThemeColor(color: string): boolean {
  const channels = rgbChannels(color);
  return channels !== null && relativeLuminance(channels) < 0.18;
}

function contrastRatio(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function themeColorContrastRatio(first: string, second: string): number {
  const firstChannels = rgbChannels(first);
  const secondChannels = rgbChannels(second);
  return firstChannels && secondChannels ? contrastRatio(firstChannels, secondChannels) : 1;
}

export function themeColorWithContrast(
  accent: string,
  surface: string | ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = (typeof surface === "string" ? [surface] : surface)
    .map(rgbChannels)
    .filter((channels) => channels !== null);
  const minimumContrast = (channels: readonly [number, number, number]) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(channels, surface)));
  if (
    !accentChannels ||
    surfaceChannels.length === 0 ||
    minimumContrast(accentChannels) >= minimum
  ) {
    return accent;
  }

  const black = [0, 0, 0] as const;
  const white = [255, 255, 255] as const;
  const target = minimumContrast(black) >= minimumContrast(white) ? black : white;
  let readable: readonly [number, number, number] = target;
  let lowerAmount = 0;
  let upperAmount = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (lowerAmount + upperAmount) / 2;
    const candidate: readonly [number, number, number] = [
      Math.round(accentChannels[0] + (target[0] - accentChannels[0]) * amount),
      Math.round(accentChannels[1] + (target[1] - accentChannels[1]) * amount),
      Math.round(accentChannels[2] + (target[2] - accentChannels[2]) * amount),
    ];
    if (minimumContrast(candidate) >= minimum) {
      readable = candidate;
      upperAmount = amount;
    } else {
      lowerAmount = amount;
    }
  }
  return `#${readable.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Unlike `themeColorWithContrast`, which blends toward black or white and greys the color out,
 * this moves only OKLCH lightness and takes the most chroma sRGB allows at each step, so a vivid
 * accent stays vivid at the contrast it needs.
 */
export function themeAccentWithContrast(
  accent: string,
  surfaces: ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = surfaces.map(rgbChannels).filter((channels) => channels !== null);
  const minimumContrast = (channels: readonly [number, number, number]) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(channels, surface)));
  if (
    !accentChannels ||
    surfaceChannels.length === 0 ||
    minimumContrast(accentChannels) >= minimum
  ) {
    return accent;
  }

  const [lightness, a, b] = srgbToOklab(accentChannels);
  const hue = Math.atan2(b, a);
  const inGamut = (channels: ReadonlyArray<number>) =>
    channels.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
  const mostVivid = (stepLightness: number) => {
    let chroma = 0;
    let lower = 0;
    let upper = Math.max(Math.hypot(a, b), 0.2);
    for (let index = 0; index < 20; index += 1) {
      const candidate = (lower + upper) / 2;
      if (
        inGamut(
          oklabToLinearSrgb(stepLightness, candidate * Math.cos(hue), candidate * Math.sin(hue)),
        )
      ) {
        chroma = candidate;
        lower = candidate;
      } else {
        upper = candidate;
      }
    }
    return oklabToSrgb(stepLightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
  };

  const lighten = minimumContrast([255, 255, 255]) >= minimumContrast([0, 0, 0]);
  const step = lighten ? 0.002 : -0.002;
  for (let next = lightness; lighten ? next <= 1 : next >= 0; next += step) {
    const candidate = mostVivid(next);
    if (minimumContrast(candidate) >= minimum) {
      return `#${candidate.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return lighten ? "#ffffff" : "#000000";
}

export function themeColorWithAlpha(color: string, alpha: number): string {
  const channels = rgbChannels(color);
  if (channels) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

export function createMobileThemeVariables(
  colors: ThemeColors,
  appearance: MobileThemeAppearance,
  groupedCardColor = colors.surface,
  prominentAction: readonly [string, string] = [colors.text, colors.canvas],
) {
  const c = nativeColors(colors);
  const groupedCard = themeColorToNativeColor(groupedCardColor);
  const textSurfaces = [
    c.canvas,
    c.surface,
    c.surfaceRaised,
    c.chrome,
    c.sidebar,
    c.secondary,
    groupedCard,
  ];
  return {
    "--color-screen": c.canvas,
    "--color-sheet": withAlpha(c.chrome, 0.98),
    "--color-sheet-solid": c.chrome,
    "--color-card": c.surface,
    "--color-grouped-card": groupedCard,
    "--color-card-alt": c.surfaceRaised,
    "--color-card-translucent": withAlpha(c.surface, 0.8),
    "--color-thread-canvas": c.canvas,
    "--color-thread-selected": c.sidebarRowActive,
    "--color-thread-selected-foreground": c.sidebarForeground,
    "--color-thread-selected-foreground-muted": themeColorWithContrast(
      c.sidebarMutedForeground,
      c.sidebarRowActive,
    ),
    "--color-thread-hover": c.sidebarRowHover,
    "--color-row-hover": c.toolbarControlHover,
    "--color-composer-panel": themeColorWithAlpha(c.canvas, appearance === "dark" ? 0.92 : 0.88),
    "--color-composer-surface": themeColorWithAlpha(
      groupedCard,
      appearance === "dark" ? 0.9 : 0.94,
    ),
    "--color-composer-border": themeColorWithAlpha(
      c.border,
      groupedCard === c.surface ? (appearance === "dark" ? 0.46 : 0.54) : 0.8,
    ),
    "--color-foreground": c.text,
    "--color-foreground-secondary": themeColorWithContrast(c.textMuted, textSurfaces),
    "--color-foreground-muted": themeColorWithContrast(c.mutedForeground, textSurfaces),
    "--color-foreground-tertiary": c.secondaryLabel,
    "--color-border": c.border,
    "--color-focus": c.focus,
    "--color-border-subtle": withAlpha(c.border, 0.7),
    "--color-separator": withAlpha(c.border, 0.55),
    "--color-subtle": c.muted,
    "--color-subtle-strong": c.secondary,
    "--color-inline-skill-background": c.accentSurface,
    "--color-inline-skill-border": withAlpha(c.accent, 0.42),
    "--color-inline-skill-foreground": c.accentSurfaceForeground,
    "--color-primary": c.messageAction,
    "--color-prominent-action": themeColorToNativeColor(prominentAction[0]),
    "--color-prominent-action-foreground": themeColorToNativeColor(prominentAction[1]),
    "--color-primary-foreground": c.messageActionForeground,
    "--color-primary-text": themeColorWithContrast(c.messageAction, textSurfaces),
    "--color-primary-shadow": "#000000",
    "--color-secondary": c.secondary,
    "--color-secondary-foreground": c.secondaryForeground,
    "--color-secondary-border": c.border,
    "--color-switch-active-track": c.messageAction,
    "--color-switch-active-thumb": c.messageActionForeground,
    "--color-switch-inactive-track": c.secondary,
    "--color-switch-inactive-thumb": c.mutedForeground,
    "--color-warning": c.warningSurface,
    "--color-warning-border": withAlpha(c.warning, 0.32),
    "--color-warning-foreground": c.warningForeground,
    "--color-danger": c.errorSurface,
    "--color-danger-border": withAlpha(c.error, 0.32),
    "--color-danger-foreground": c.errorForeground,
    "--color-update": c.updateSurface,
    "--color-update-foreground": c.updateForeground,
    "--color-input": c.surface,
    "--color-input-border": c.input,
    "--color-sidebar-search": c.sidebarControlSurface,
    "--color-placeholder": themeColorWithContrast(c.placeholder, textSurfaces),
    "--color-icon": c.text,
    "--color-icon-muted": c.iconMuted,
    "--color-icon-subtle": c.secondaryLabel,
    "--color-header": withAlpha(c.toolbar, 0.97),
    "--color-header-foreground": c.toolbarForeground,
    "--color-header-border": c.toolbarBorder,
    "--color-glass-surface": withAlpha(c.surfaceOverlay, 0.74),
    "--color-glass-fallback": themeColorWithAlpha(groupedCard, appearance === "dark" ? 0.9 : 0.94),
    "--color-glass-tint": withAlpha(c.surfaceOverlay, 0.22),
    "--color-status-bar": c.canvas,
    "--color-md-body": c.text,
    "--color-md-strong": c.text,
    "--color-md-link": themeColorWithContrast(c.messageAction, c.canvas),
    "--color-md-blockquote-border": c.border,
    "--color-md-blockquote-bg": c.muted,
    "--color-md-code-bg": c.codeBackground,
    "--color-md-code-text": c.codeForeground,
    "--color-md-user-code-bg": withAlpha(c.messageForeground, 0.18),
    "--color-md-user-code-text": c.messageForeground,
    "--color-md-user-fence-bg": withAlpha("#000000", appearance === "dark" ? 0.28 : 0.16),
    "--color-md-user-fence-text": c.messageForeground,
    "--color-md-hr": c.border,
    "--color-user-bubble": c.messageSurface,
    "--color-user-bubble-foreground": c.messageForeground,
    "--color-user-bubble-foreground-muted": withAlpha(c.messageForeground, 0.78),
    "--color-user-bubble-skill-foreground": themeColorWithContrast(
      c.messageAction,
      c.messageSurface,
    ),
    "--color-backdrop": withAlpha("#000000", appearance === "dark" ? 0.48 : 0.22),
    "--color-drawer": c.sidebar,
    "--color-drawer-foreground": c.sidebarForeground,
    "--color-drawer-foreground-muted": themeColorWithContrast(c.sidebarMutedForeground, [
      c.sidebar,
      c.sidebarRowHover,
    ]),
    "--color-drawer-border": c.sidebarBorder,
    "--color-drawer-shadow": withAlpha("#000000", appearance === "dark" ? 0.32 : 0.12),
    "--color-dot-separator": withAlpha(c.textMuted, 0.35),
    "--color-wordmark": c.text,
    "--color-chevron": withAlpha(c.textMuted, 0.42),
  };
}

// Tokens come from the DIMAGGI website's scientific theme
// (dimaggi/website/frontend/src/scientific-theme.css). Roles the site does not
// define, such as warnings, search highlights and ANSI terminal colors, keep the
// T3 Code values.
export const DIMAGGI_LIGHT_THEME_COLORS: ThemeColors = {
  ...T3_CODE_LIGHT_THEME_COLORS,
  canvas: "#ffffff",
  chrome: "#ffffff",
  toolbar: "#ffffff",
  toolbarForeground: "#303036",
  toolbarBorder: "#b9bec4",
  toolbarControl: "#ffffff",
  toolbarControlForeground: "#303036",
  toolbarControlHover: "#f4f4f5",
  surface: "#ffffff",
  surfaceRaised: "#f4f4f5",
  surfaceOverlay: "#ffffff",
  text: "#303036",
  textMuted: "#626268",
  border: "#b9bec4",
  input: "#b9bec4",
  focus: "#1a7c93",
  accent: "#1a7c93",
  accentForeground: "#ffffff",
  secondary: "#f4f4f5",
  secondaryForeground: "#303036",
  muted: "#f4f4f5",
  mutedForeground: "#626268",
  placeholder: "#626268",
  secondaryLabel: "#626268",
  iconMuted: "#626268",
  error: "#a02038",
  errorForeground: "#a02038",
  update: "#1a7c93",
  updateForeground: "#1a7c93",
  updateSurface: "#e7e7e9",
  accentSurface: "#f4f4f5",
  accentSurfaceForeground: "#303036",
  messageSurface: "#f4f4f5",
  messageForeground: "#303036",
  messageAction: "#1a7c93",
  messageActionForeground: "#ffffff",
  messageActionHover: "#155f71",
  codeBackground: "#f4f4f5",
  codeForeground: "#3a3a3e",
  sidebar: "#f4f4f5",
  sidebarForeground: "#303036",
  sidebarMutedForeground: "#626268",
  sidebarControlSurface: "#e7e7e9",
  sidebarRowHover: "#e7e7e9",
  sidebarRowActive: "#ffffff",
  sidebarRowSelected: "#ffffff",
  sidebarBorder: "#b9bec4",
  terminalBackground: "#ffffff",
  terminalForeground: "#303036",
  terminalCursor: "#1a7c93",
};

export const DIMAGGI_DARK_THEME_COLORS: ThemeColors = {
  ...T3_CODE_DARK_THEME_COLORS,
  canvas: "#252528",
  chrome: "#252528",
  toolbar: "#252528",
  toolbarForeground: "#ffffff",
  toolbarBorder: "#626268",
  toolbarControl: "#303036",
  toolbarControlForeground: "#ffffff",
  toolbarControlHover: "#3a3a3e",
  surface: "#303036",
  surfaceRaised: "#3a3a3e",
  surfaceOverlay: "#303036",
  text: "#ffffff",
  textMuted: "#b9bec4",
  border: "#626268",
  input: "#626268",
  focus: "#76b0be",
  accent: "#76b0be",
  accentForeground: "#0b0b0c",
  secondary: "#303036",
  secondaryForeground: "#ffffff",
  muted: "#303036",
  mutedForeground: "#b9bec4",
  placeholder: "#b9bec4",
  secondaryLabel: "#b9bec4",
  iconMuted: "#b9bec4",
  error: "#ffb5bc",
  errorForeground: "#ffb5bc",
  update: "#76b0be",
  updateForeground: "#76b0be",
  updateSurface: "#303036",
  accentSurface: "#303036",
  accentSurfaceForeground: "#ffffff",
  messageSurface: "#303036",
  messageForeground: "#e1e1e3",
  // The site keeps its brand-blue button fill in dark mode and uses #76b0be for links.
  messageAction: "#1a7c93",
  messageActionForeground: "#ffffff",
  messageActionHover: "#155f71",
  codeBackground: "#303036",
  codeForeground: "#e1e1e3",
  sidebar: "#252528",
  sidebarForeground: "#ffffff",
  sidebarMutedForeground: "#b9bec4",
  sidebarControlSurface: "#303036",
  sidebarRowHover: "#303036",
  sidebarRowActive: "#3a3a3e",
  sidebarRowSelected: "#3a3a3e",
  sidebarBorder: "#626268",
  terminalBackground: "#252528",
  terminalForeground: "#e1e1e3",
  terminalCursor: "#76b0be",
};

export function getMobileThemeColors(
  themeId: MobileColorThemeId,
  appearance: MobileThemeAppearance,
): ThemeColors {
  if (themeId === DIMAGGI_MOBILE_THEME_ID) {
    return appearance === "dark" ? DIMAGGI_DARK_THEME_COLORS : DIMAGGI_LIGHT_THEME_COLORS;
  }
  if (themeId === DEFAULT_MOBILE_THEME_ID) {
    return appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
  }
  const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId) ?? T3_CHAT_THEME;
  return getThemeColorsForAppearance(theme, appearance) ?? theme.colors;
}

export function getMobileThemeVariables(
  themeId: MobileColorThemeId,
  appearance: MobileThemeAppearance,
  overrides: Partial<MobileThemeVariables> | null = null,
): MobileThemeVariables {
  const colors = getMobileThemeColors(themeId, appearance);
  const groupedCard =
    themeId === DEFAULT_MOBILE_THEME_ID
      ? appearance === "light"
        ? colors.toolbarControlHover
        : colors.sidebarRowActive
      : themeId === "t3-chat"
        ? appearance === "light"
          ? colors.toolbarControl
          : colors.surface
        : colors.muted;
  const mobileColors =
    themeId === DEFAULT_MOBILE_THEME_ID
      ? {
          ...colors,
          messageSurface: flattenThemeColor(
            themeColorWithAlpha(
              appearance === "dark" ? colors.sidebarRowActive : colors.border,
              0.3,
            ),
            colors.messageSurface,
          ),
        }
      : colors;
  const baseVariables = createMobileThemeVariables(
    mobileColors,
    appearance,
    groupedCard,
    themeId === "t3-chat" && appearance === "dark"
      ? [colors.messageActionForeground, colors.messageAction]
      : themeId !== DEFAULT_MOBILE_THEME_ID && themeId !== "t3-chat"
        ? [colors.messageAction, colors.messageActionForeground]
        : undefined,
  );

  return overrides ? ({ ...baseVariables, ...overrides } as MobileThemeVariables) : baseVariables;
}

export function getMobileThemePreviewColors(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): ThemePreviewColors {
  if (themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you")
    return STANDARD_THEME_PREVIEW_COLORS[appearance];
  const colors = getMobileThemeColors(themeId, appearance);
  return {
    canvas: themeColorToNativeColor(colors.canvas),
    accent: themeColorToNativeColor(colors.accent),
    messageAction: themeColorToNativeColor(colors.messageAction),
  };
}
