import { D4AgentControls } from "./D4AgentControls";
import { useAtomValue } from "@effect/atom-react";
import type { ServerSettings } from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  monitorActivityThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "@d4research/client-runtime/state/agent-monitor";
import { useLinkTo } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { AppState, Modal, Pressable, View } from "react-native";
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
          Choose an environment to configure d4 Agent.
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState("Checking notification permission…");
  useEffect(() => {
    let active = true;
    const readPermission = () => {
      void Notifications.getPermissionsAsync()
        .then((result) => {
          if (active)
            setPermissionState(
              result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
                ? "Notifications: provisional"
                : result.granted
                  ? "Notifications: allowed"
                  : "Notifications: not allowed",
            );
        })
        .catch(() => {
          if (active) setPermissionState("Notification permission unavailable");
        });
    };
    readPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") readPermission();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(target.environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const monitor = target.serverConfig.settings.agentMonitor;
  if (!monitor) return null;
  const agent = target.serverConfig.settings.d4Agent;
  const groups = groupByProvider(buildModelOptions(config, agent.modelSelection, undefined, null));
  const monitored = threads.filter(
    (thread) =>
      thread.environmentId === target.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.source.agentMonitor,
  );
  const attention = monitorAttentionThreads(monitored);
  const activity = monitorActivityThreads(monitored);
  const listCount = (count: number) =>
    count > AGENT_MONITOR_LIST_LIMIT ? `${AGENT_MONITOR_LIST_LIMIT}/${count}` : String(count);
  const write = async (patch: Partial<ServerSettings["agentMonitor"]>) => {
    if (saving || !allowed) return;
    setSaving(true);
    setSaveError(null);
    await updateSettings({
      environmentId: target.environmentId,
      input: { patch: { agentMonitor: { ...monitor, ...patch } } },
    })
      .then((result) => {
        if (result._tag === "Failure") setSaveError("Could not save d4 Agent settings.");
      })
      .catch(() => setSaveError("Could not save d4 Agent settings."))
      .finally(() => setSaving(false));
  };
  const writeAgent = async (patch: Partial<ServerSettings["d4Agent"]>) => {
    if (saving || !allowed) return;
    setSaving(true);
    setSaveError(null);
    await updateSettings({
      environmentId: target.environmentId,
      input: { patch: { d4Agent: { ...agent, ...patch } } },
    })
      .then((result) => {
        if (result._tag === "Failure") setSaveError("Could not save d4 Agent settings.");
      })
      .catch(() => setSaveError("Could not save d4 Agent settings."))
      .finally(() => setSaving(false));
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
    if (enabled) {
      const current = await Notifications.getPermissionsAsync().catch(() => null);
      setPermissionState(
        current?.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
          ? "Notifications: provisional"
          : current?.granted
            ? "Notifications: allowed"
            : "Notifications: not allowed",
      );
    }
    await write({ notificationsEnabled: enabled });
  };
  return (
    <View className="gap-3">
      <SettingsSection title={`d4 Agent · ${target.label}`}>
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Monitor threads"
          value={monitor.enabled}
          disabled={!allowed || saving}
          onValueChange={(enabled) => void write({ enabled })}
        />
        <SettingsSwitchRow
          icon="bubble.left"
          label="Enable agent chat"
          value={agent.enabled}
          disabled={!allowed || saving}
          onValueChange={(enabled) => void writeAgent({ enabled })}
        />
        <SettingsRow
          icon="gearshape"
          label="Agent model"
          value={
            agent.modelSelection
              ? `${agent.modelSelection.instanceId} · ${agent.modelSelection.model}`
              : "Choose model"
          }
          disabled={!allowed || saving}
          onPress={() => setPickerOpen(true)}
        />
        {agent.modelSelection ? (
          <SettingsRow
            icon="xmark"
            label="Clear agent model"
            disabled={!allowed || saving}
            onPress={() => void writeAgent({ modelSelection: null })}
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
        Thread monitoring uses local rules. Agent chat uses the selected model. Unavailable models
        keep the agent off.
      </Text>
      <D4AgentControls
        environmentId={target.environmentId}
        agent={agent}
        monitor={monitor}
        config={config}
        disabled={!allowed || saving}
        writeAgent={writeAgent}
        writeMonitor={write}
      />
      <Text className="px-2 text-sm text-foreground-muted">{permissionState}</Text>
      {saveError ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground-muted">
          {saveError}
        </Text>
      ) : null}
      {permissionMessage ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground-muted">
          {permissionMessage}
        </Text>
      ) : null}
      {monitor.enabled ? (
        <SettingsSection title={`Needs attention · ${listCount(attention.length)}`}>
          {attention.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">No threads need attention.</Text>
          ) : (
            attention
              .slice(0, AGENT_MONITOR_LIST_LIMIT)
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
              ))
          )}
        </SettingsSection>
      ) : null}
      {monitor.enabled && activity.length > 0 ? (
        <SettingsSection title={`Thread activity · ${listCount(activity.length)}`}>
          {activity.slice(0, AGENT_MONITOR_LIST_LIMIT).map((thread) => (
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
            <Text className="text-lg font-t3-semibold text-foreground">d4 Agent model</Text>
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
                      option.selection.instanceId === agent.modelSelection?.instanceId &&
                      option.selection.model === agent.modelSelection.model
                    }
                    onPress={() => {
                      void writeAgent({ modelSelection: option.selection });
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
