import { ProjectRailGroupStylePicker } from "./ProjectRailGroupStylePicker";
import { ChatCustomWidthControl } from "./ChatCustomWidthControl";
import { cn } from "../../lib/utils";
import type { CSSProperties } from "react";
import { useState } from "react";
import {
  type ComposerActionStyle,
  DEFAULT_COMPOSER_ACTION_STYLE,
  DEFAULT_PROJECT_RAIL_GROUP_STYLE,
  DEFAULT_COMPOSER_ORB_SEND_COLOR,
  DEFAULT_COMPOSER_ORB_STOP_COLOR,
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EffortDisplay,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@d4research/contracts/settings";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";
import { ThreadDetailsItemsRow } from "./ThreadDetailsItemsRow";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  "nightly-artwork": "Nightly artwork",
  "dev-artwork": "Dev artwork",
  pill: "Version pill",
  none: "None",
};

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
  custom: "Custom",
};

/**
 * Accent presets. Hues spread far enough apart to be told apart at swatch size; the exact lightness
 * matters less than it looks, since the theme pulls a chosen colour into its own accent band.
 */
const APP_ACCENT_SWATCHES = [
  { hex: "#3b6ef0", label: "Blue" },
  { hex: "#0e9488", label: "Teal" },
  { hex: "#16a34a", label: "Green" },
  { hex: "#c2851b", label: "Amber" },
  { hex: "#e0662c", label: "Orange" },
  { hex: "#dc2626", label: "Red" },
  { hex: "#db2777", label: "Pink" },
  { hex: "#7c3aed", label: "Violet" },
] as const;

const DEFAULT_APP_ACCENT_HEX = APP_ACCENT_SWATCHES[0].hex;

const ORB_SEND_SWATCHES = [
  { hex: "#8b5cff", label: "violet" },
  { hex: "#6d5cff", label: "indigo" },
  { hex: "#a855f7", label: "purple" },
  { hex: "#5b7cff", label: "blue" },
  { hex: "#22b8c8", label: "teal" },
  { hex: "#e0761f", label: "amber" },
] as const;

const ORB_STOP_SWATCHES = [
  { hex: "#e2323a", label: "crimson" },
  { hex: "#c81e2a", label: "blood" },
  { hex: "#ff5a45", label: "coral" },
  { hex: "#f43f5e", label: "rose" },
  { hex: "#d9463d", label: "ember" },
  { hex: "#a21caf", label: "magenta" },
] as const;
const EFFORT_DISPLAY_LABELS: Record<EffortDisplay, string> = {
  label: "Word",
  bars: "Bars",
};

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const showEnvironmentIdentification = true;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="Colors & themes" variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title="Interface">
        <SettingsRow
          {...searchableSetting("setting-accent-color")}
          description="The colour of primary buttons, the focus ring, and the send action. Overrides the accent of whichever theme is active; clear it to hand that back."
          resetAction={
            settings.accentColor !== null ? (
              <SettingResetButton
                label="accent colour"
                onClick={() => updateSettings({ accentColor: null })}
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {APP_ACCENT_SWATCHES.map((swatch) => (
                <button
                  key={swatch.hex}
                  type="button"
                  aria-label={swatch.label}
                  aria-pressed={settings.accentColor === swatch.hex}
                  className={cn(
                    "size-5 cursor-pointer rounded-full border transition-transform",
                    settings.accentColor === swatch.hex
                      ? "scale-110 border-foreground"
                      : "border-border/70 hover:scale-110",
                  )}
                  style={{ backgroundColor: swatch.hex }}
                  onClick={() => updateSettings({ accentColor: swatch.hex })}
                />
              ))}
              <label className="ms-1 inline-flex cursor-pointer items-center gap-1 text-xs text-secondary-label">
                <input
                  type="color"
                  className="size-5 cursor-pointer rounded-full border border-border/70 bg-transparent p-0"
                  value={settings.accentColor ?? DEFAULT_APP_ACCENT_HEX}
                  aria-label="Custom accent colour"
                  onChange={(event) => updateSettings({ accentColor: event.target.value })}
                />
                Custom
              </label>
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description="Adjust the contrast of text, borders, and controls."
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label="Contrast"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("composer-action-style")}
          description="Arcane orb replaces the send and stop buttons with a lit glass sphere whose plasma keeps moving while it is on screen."
          resetAction={
            settings.composerActionStyle !== DEFAULT_COMPOSER_ACTION_STYLE ? (
              <SettingResetButton
                label="composer buttons"
                onClick={() =>
                  updateSettings({ composerActionStyle: DEFAULT_COMPOSER_ACTION_STYLE })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.composerActionStyle}
              onValueChange={(value) =>
                updateSettings({ composerActionStyle: value as ComposerActionStyle })
              }
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Composer buttons">
                <SelectValue>
                  {settings.composerActionStyle === "orb" ? "Arcane orb" : "Classic"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="orb">
                  Arcane orb
                </SelectItem>
                <SelectItem hideIndicator value="classic">
                  Classic
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.composerActionStyle === "orb" ? (
          <SettingsRow
            {...searchableSetting("composer-orb-colors")}
            description="The accent each orb burns with: send on the left, stop on the right."
            resetAction={
              settings.composerOrbSendColor !== DEFAULT_COMPOSER_ORB_SEND_COLOR ||
              settings.composerOrbStopColor !== DEFAULT_COMPOSER_ORB_STOP_COLOR ? (
                <SettingResetButton
                  label="orb colours"
                  onClick={() =>
                    updateSettings({
                      composerOrbSendColor: DEFAULT_COMPOSER_ORB_SEND_COLOR,
                      composerOrbStopColor: DEFAULT_COMPOSER_ORB_STOP_COLOR,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-col items-end gap-2">
                {(
                  [
                    {
                      key: "composerOrbSendColor",
                      label: "Send",
                      value: settings.composerOrbSendColor,
                      swatches: ORB_SEND_SWATCHES,
                    },
                    {
                      key: "composerOrbStopColor",
                      label: "Stop",
                      value: settings.composerOrbStopColor,
                      swatches: ORB_STOP_SWATCHES,
                    },
                  ] as const
                ).map((row) => (
                  <div key={row.key} className="flex flex-wrap items-center justify-end gap-1.5">
                    <span className="me-1 text-xs text-secondary-label">{row.label}</span>
                    {row.swatches.map((swatch) => (
                      <button
                        key={swatch.hex}
                        type="button"
                        aria-label={`${row.label} orb ${swatch.label}`}
                        aria-pressed={row.value === swatch.hex}
                        className={cn(
                          "size-5 cursor-pointer rounded-full border transition-transform",
                          row.value === swatch.hex
                            ? "scale-110 border-foreground"
                            : "border-border/70 hover:scale-110",
                        )}
                        style={{ backgroundColor: swatch.hex }}
                        onClick={() => updateSettings({ [row.key]: swatch.hex })}
                      />
                    ))}
                    <input
                      type="color"
                      className="size-5 cursor-pointer rounded-full border border-border/70 bg-transparent p-0"
                      value={row.value}
                      aria-label={`Custom ${row.label.toLowerCase()} orb colour`}
                      onChange={(event) => updateSettings({ [row.key]: event.target.value })}
                    />
                  </div>
                ))}
              </div>
            }
          />
        ) : null}

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="Choose how Dev and Nightly environments are identified."
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (
                    value === "artwork" ||
                    value === "nightly-artwork" ||
                    value === "dev-artwork" ||
                    value === "pill" ||
                    value === "none"
                  ) {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Environment identification"
                >
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("diff-color-scheme")}
          description="Choose colors for additions and deletions, including change counts."
          resetAction={
            settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
              <SettingResetButton
                label="diff colors"
                onClick={() =>
                  updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.diffColorScheme}
                onValueChange={(value) => {
                  if (value === "red-green" || value === "blue-orange")
                    updateSettings({ diffColorScheme: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Diff colors">
                  <span
                    aria-hidden="true"
                    className={
                      settings.diffColorScheme === "blue-orange"
                        ? "flex shrink-0 flex-row-reverse gap-1"
                        : "flex shrink-0 gap-1"
                    }
                  >
                    <span className="size-2 rounded-full bg-diff-deletion" />
                    <span className="size-2 rounded-full bg-diff-addition" />
                  </span>
                  <SelectValue>
                    {settings.diffColorScheme === "blue-orange" ? "Blue & orange" : "Red & green"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="red-green">Red & green (default)</SelectItem>
                  <SelectItem value="blue-orange">Blue & orange</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("composer-context")}
          description="Keep branch and worktree controls below the composer after a thread starts."
          resetAction={
            settings.persistComposerContextStrip !==
            DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
              <SettingResetButton
                label="composer context"
                onClick={() =>
                  updateSettings({
                    persistComposerContextStrip:
                      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.persistComposerContextStrip}
              onCheckedChange={(checked) =>
                updateSettings({ persistComposerContextStrip: Boolean(checked) })
              }
              aria-label="Keep composer context visible in active threads"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("chat-width")}
          description="Set the maximum width of messages and the composer. The column is centered; smaller widths leave larger side margins."
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ||
            settings.chatCustomWidthPx !== DEFAULT_UNIFIED_SETTINGS.chatCustomWidthPx ? (
              <SettingResetButton
                label="chat width"
                onClick={() =>
                  updateSettings({
                    chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
                    chatCustomWidthPx: DEFAULT_UNIFIED_SETTINGS.chatCustomWidthPx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full flex-col gap-2 sm:w-44">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (
                    value === "comfortable" ||
                    value === "wide" ||
                    value === "full" ||
                    value === "custom"
                  )
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">
                  <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">Comfortable (default)</SelectItem>
                  <SelectItem value="wide">Wide</SelectItem>
                  <SelectItem value="full">Full</SelectItem>
                  <SelectItem value="custom">Custom (pixels)</SelectItem>
                </SelectPopup>
              </Select>
              {settings.chatWidth === "custom" ? (
                <ChatCustomWidthControl
                  value={settings.chatCustomWidthPx}
                  onChange={(chatCustomWidthPx) => updateSettings({ chatCustomWidthPx })}
                />
              ) : null}
            </div>
          }
        />
        <ThreadDetailsItemsRow />
        <SettingsRow
          {...searchableSetting("effort-display")}
          description="Show reasoning effort in the composer as its name, such as High, or as bars."
          resetAction={
            settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay ? (
              <SettingResetButton
                label="effort display"
                onClick={() =>
                  updateSettings({ effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.effortDisplay}
                onValueChange={(value) => {
                  if (value === "bars" || value === "label")
                    updateSettings({ effortDisplay: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Effort display">
                  <SelectValue>{EFFORT_DISPLAY_LABELS[settings.effortDisplay]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="label">Word (default)</SelectItem>
                  <SelectItem value="bars">Bars</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("math-rendering")}
          description="Typeset LaTeX math, such as $x^2$ or \[x^2\], in messages and Markdown previews. The composer keeps TeX source editable."
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                label="math rendering"
                onClick={() =>
                  updateSettings({
                    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.mathRenderingEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ mathRenderingEnabled: Boolean(checked) })
              }
              aria-label="Render math"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="appearance-project-rail" title="Project rail">
        <SettingsRow
          {...searchableSetting("project-rail-group-style")}
          description="How groups look in the project rail, in both the short and the named view."
          resetAction={
            settings.projectRailGroupStyle !== DEFAULT_PROJECT_RAIL_GROUP_STYLE ? (
              <SettingResetButton
                label="project group style"
                onClick={() =>
                  updateSettings({ projectRailGroupStyle: DEFAULT_PROJECT_RAIL_GROUP_STYLE })
                }
              />
            ) : null
          }
        >
          <ProjectRailGroupStylePicker
            value={settings.projectRailGroupStyle}
            onChange={(projectRailGroupStyle) => updateSettings({ projectRailGroupStyle })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="motion" title="Motion">
        <SettingsRow
          {...searchableSetting("panel-animations")}
          description="Set how fast panels open and close."
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label="Panel animation duration"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="panel animations"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}
