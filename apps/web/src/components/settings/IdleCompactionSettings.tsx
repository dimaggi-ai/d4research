import { useState } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@d4research/contracts";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingResetButton, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function ThresholdField({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number | null;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <NumberField
      value={draft}
      min={min}
      max={max}
      step={1}
      size="sm"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null || !Number.isInteger(next) || next < min || next > max) {
          setDraft(value);
          return;
        }
        onChange(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldInput aria-label={label} placeholder="Mixed" />
      </NumberFieldGroup>
    </NumberField>
  );
}

export function IdleCompactionSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixedMinutes = useScopedSettingsMixed(["idleCompactionMinutes"]);
  const mixedTokens = useScopedSettingsMixed(["idleCompactionTokens"]);
  return (
    <SettingsSection id="automatic-compaction" title="Automatic compaction">
      <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
        Set global defaults here, or select a project above to override individual values. The
        indicator beside each setting shows where its value comes from and which projects override
        it.
      </p>
      <SettingsRow
        id="idle-compaction"
        title="Enable automatic compaction"
        serverScoped
        settingKeys={["idleCompactionEnabled"]}
        description="Compact large Claude and Codex sessions between replies. Off by default; the server must stay running. Active replies, queued messages, and unanswered questions always wait."
        resetAction={
          settings.idleCompactionEnabled ? (
            <SettingResetButton
              label="idle compaction"
              onClick={() => update({ idleCompactionEnabled: false })}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["idleCompactionEnabled"]}
            checked={settings.idleCompactionEnabled}
            aria-label="Enable automatic compaction"
            onCheckedChange={(value) => update({ idleCompactionEnabled: Boolean(value) })}
          />
        }
      />
      <SettingsRow
        id="idle-compaction-background"
        title="Allow background work to continue"
        serverScoped
        settingKeys={["idleCompactionAllowBackgroundWork"]}
        description="Keep native monitors, background commands, and provider subagents running during compaction. Turn off to wait until all work finishes. T3-managed delegated tasks and other pending tools still wait."
        resetAction={
          !settings.idleCompactionAllowBackgroundWork ? (
            <SettingResetButton
              label="compaction with background work"
              onClick={() => update({ idleCompactionAllowBackgroundWork: true })}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["idleCompactionAllowBackgroundWork"]}
            checked={settings.idleCompactionAllowBackgroundWork}
            aria-label="Allow background work during compaction"
            onCheckedChange={(value) =>
              update({ idleCompactionAllowBackgroundWork: Boolean(value) })
            }
          />
        }
      />
      <SettingsRow
        id="idle-compaction-timeout"
        title="Idle time before compaction"
        serverScoped
        settingKeys={["idleCompactionMinutes"]}
        description="Minutes since the last reply finished (1–1,440). When background work is allowed, its output does not reset the timer. Otherwise the timer waits for all work to finish. Reading the thread does not reset it."
        resetAction={
          settings.idleCompactionMinutes !== DEFAULT_SERVER_SETTINGS.idleCompactionMinutes ? (
            <SettingResetButton
              label="idle compaction timeout"
              onClick={() =>
                update({ idleCompactionMinutes: DEFAULT_SERVER_SETTINGS.idleCompactionMinutes })
              }
            />
          ) : null
        }
        control={
          <ThresholdField
            key={mixedMinutes ? "mixed" : settings.idleCompactionMinutes}
            value={mixedMinutes ? null : settings.idleCompactionMinutes}
            min={1}
            max={1440}
            label="Idle minutes before compaction"
            onChange={(value) => update({ idleCompactionMinutes: value })}
          />
        }
      />
      <SettingsRow
        id="idle-compaction-tokens"
        title="Context token threshold"
        serverScoped
        settingKeys={["idleCompactionTokens"]}
        description="Compact when reported context reaches this token count. Sessions without reported usage are skipped."
        resetAction={
          settings.idleCompactionTokens !== DEFAULT_SERVER_SETTINGS.idleCompactionTokens ? (
            <SettingResetButton
              label="idle compaction token threshold"
              onClick={() =>
                update({ idleCompactionTokens: DEFAULT_SERVER_SETTINGS.idleCompactionTokens })
              }
            />
          ) : null
        }
        control={
          <ThresholdField
            key={mixedTokens ? "mixed" : settings.idleCompactionTokens}
            value={mixedTokens ? null : settings.idleCompactionTokens}
            min={1000}
            max={10000000}
            label="Context tokens before idle compaction"
            onChange={(value) => update({ idleCompactionTokens: value })}
          />
        }
      />
    </SettingsSection>
  );
}
