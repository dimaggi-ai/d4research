import { SettingsSection } from "./settingsLayout";

export function TelemetryExportSettings() {
  return (
    <SettingsSection title="OpenTelemetry export" id="telemetry-export">
      <p className="text-sm text-muted-foreground">
        External telemetry exports are disabled in this fork.
      </p>
    </SettingsSection>
  );
}
