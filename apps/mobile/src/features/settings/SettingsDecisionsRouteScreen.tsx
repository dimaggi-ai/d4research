import type { DecisionSettings } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsTextField } from "./components/SettingsTextField";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const ENDPOINT_HELP =
  "Agents send text to this endpoint to get yes/no, choice, and score answers. To turn decisions off, leave the field blank.";

export function SettingsDecisionsRouteScreen() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Decisions" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 py-4"
          contentContainerStyle={{ paddingBottom: 48 }}
        >
          {selectedProjectKey !== null ? (
            <Text>Select All projects to manage decision settings.</Text>
          ) : selectedTargets.length === 0 ? (
            <Text>Select a connected environment.</Text>
          ) : (
            selectedTargets.map((target) => (
              <EnvironmentDecisions key={target.environmentId} target={target} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentDecisions({ target }: { target: SettingsTarget }) {
  const { environmentId } = target;
  const settings = target.serverConfig.settings.decision;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const write = async (patch: Partial<DecisionSettings>) => {
    setError(null);
    const result = await update({ environmentId, input: { patch: { decision: patch } } });
    if (result._tag !== "Success") setError("Could not save decision settings.");
  };
  return (
    <View className="gap-2">
      <SettingsSection title={target.label} footer={ENDPOINT_HELP}>
        <SettingsTextField
          label="OpenJev endpoint"
          value={settings.baseUrl}
          disabled={!canWrite}
          placeholder="http://127.0.0.1:19098"
          onSave={(baseUrl) => void write({ baseUrl })}
        />
        <SettingsTextField
          label="Decision model"
          value={settings.model}
          disabled={!canWrite}
          onSave={(model) => {
            if (model === "") setError("Enter a model name.");
            else void write({ model });
          }}
        />
      </SettingsSection>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
