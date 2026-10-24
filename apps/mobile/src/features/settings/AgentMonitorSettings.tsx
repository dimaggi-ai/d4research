import { useAtomValue } from "@effect/atom-react";
import type { ServerSettings } from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
} from "@d4research/client-runtime/state/agent-monitor";
import { useLinkTo } from "@react-navigation/native";
import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import * as Effect from "effect/Effect";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ModelRow } from "../threads/ThreadSettingsRows";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function AgentMonitorSettings() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  return (
    <View className="gap-4">
      {selectedProjectKey !== null ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Choose an environment to configure its monitor.
        </Text>
      ) : (
        selectedTargets.map((target) => (
          <EnvironmentMonitorSettings key={target.environmentId} target={target} />
        ))
      )}
    </View>
  );
}

function EnvironmentMonitorSettings({
  target,
}: {
  readonly target: ReturnType<typeof useSettingsEnvironmentFilter>["selectedTargets"][number];
}) {
  const threads = useThreadShells();
  const config = useEnvironmentServerConfig(target.environmentId);
  const linkTo = useLinkTo();
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(target.environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const monitor = target.serverConfig.settings.agentMonitor;
  if (!monitor) return null;
  const groups = groupByProvider(
    buildModelOptions(config, monitor.modelSelection, undefined, null),
  );
  const monitored = threads.filter(
    (thread) =>
      thread.environmentId === target.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.source.agentMonitor,
  );
  const attention = monitorAttentionThreads(monitored);
  const write = async (patch: Partial<ServerSettings["agentMonitor"]>) => {
    if (saving || !allowed) return;
    setSaving(true);
    try {
      await updateSettings({
        environmentId: target.environmentId,
        input: { patch: { agentMonitor: { ...monitor, ...patch } } },
      });
    } finally {
      setSaving(false);
    }
  };
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const permission = await Effect.runPromise(
        requestAgentNotificationPermission.pipe(
          Effect.catch(() => Effect.succeed({ type: "denied" as const })),
        ),
      );
      if (permission.type !== "granted") {
        setPermissionMessage("Allow notifications in device settings to receive monitor alerts.");
        return;
      }
    }
    setPermissionMessage(null);
    await write({ notificationsEnabled: enabled });
  };
  return (
    <View className="gap-3">
      <SettingsSection title={`Monitor · ${target.label}`}>
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Monitor threads"
          value={monitor.enabled}
          disabled={!allowed || saving}
          onValueChange={(enabled) => void write({ enabled })}
        />
        <SettingsRow
          icon="gearshape"
          label="Saved model"
          value={
            monitor.modelSelection
              ? `${monitor.modelSelection.instanceId} · ${monitor.modelSelection.model}`
              : "Choose model"
          }
          disabled={!allowed || saving}
          onPress={() => setPickerOpen(true)}
        />
        {monitor.modelSelection ? (
          <SettingsRow
            icon="xmark"
            label="Clear saved model"
            disabled={!allowed || saving}
            onPress={() => void write({ modelSelection: null })}
          />
        ) : null}
        <SettingsSwitchRow
          icon="bell.badge"
          label="Attention notifications"
          value={monitor.notificationsEnabled}
          disabled={!allowed || saving}
          onValueChange={(enabled) => void toggleNotifications(enabled)}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Classifies thread activity locally. No model calls or automatic recovery actions. The saved
        model does not change running threads.
      </Text>
      {permissionMessage ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground-muted">
          {permissionMessage}
        </Text>
      ) : null}
      {monitor.enabled ? (
        <SettingsSection title={`Needs attention · ${attention.length}`}>
          {attention.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">No threads need attention.</Text>
          ) : (
            attention.map((thread) => (
              <SettingsRow
                key={thread.id}
                icon="bubble.left"
                label={thread.title}
                value={agentMonitorLabel(thread.source.agentMonitor!)}
                onPress={() =>
                  linkTo(
                    `/threads/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(thread.id)}`,
                  )
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}
      {monitor.enabled &&
      monitored.some((thread) => !thread.source.agentMonitor?.attentionRequired) ? (
        <SettingsSection title="Thread activity">
          {monitored
            .filter((thread) => !thread.source.agentMonitor?.attentionRequired)
            .map((thread) => (
              <SettingsRow
                key={thread.id}
                icon="bubble.left"
                label={thread.title}
                value={agentMonitorLabel(thread.source.agentMonitor!)}
                onPress={() =>
                  linkTo(
                    `/threads/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(thread.id)}`,
                  )
                }
              />
            ))}
        </SettingsSection>
      ) : null}
      <Modal
        visible={pickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View className="flex-1 bg-background pt-6">
          <View className="flex-row items-center justify-between px-5 pb-4">
            <Text className="text-lg font-t3-semibold text-foreground">Saved monitor model</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(false)}
              className="p-2"
            >
              <Text className="text-base text-accent">Done</Text>
            </Pressable>
          </View>
          <ScreenScrollView contentContainerClassName="gap-4 pb-10">
            {groups.map((group) => (
              <View key={group.providerKey} className="gap-2">
                <Text className="px-5 text-sm text-foreground-muted">{group.providerLabel}</Text>
                {group.models.map((option, index) => (
                  <ModelRow
                    key={option.key}
                    option={option}
                    selected={
                      option.selection.instanceId === monitor.modelSelection?.instanceId &&
                      option.selection.model === monitor.modelSelection.model
                    }
                    onPress={() => {
                      void write({ modelSelection: option.selection });
                      setPickerOpen(false);
                    }}
                    isFavorite={false}
                    favoritesLoaded={false}
                    onToggleFavorite={() => {}}
                    isFirst={index === 0}
                    isLast={index === group.models.length - 1}
                  />
                ))}
              </View>
            ))}
            {groups.length === 0 ? (
              <Text className="p-5 text-sm text-foreground-muted">No providers available.</Text>
            ) : null}
          </ScreenScrollView>
        </View>
      </Modal>
    </View>
  );
}
