import { useD4AgentState } from "../agent-awareness/useD4AgentState";
import { NIA_SERVERS } from "@d4research/client-runtime/niaServers";
import { fetchEnvironmentSkillsInventory } from "@d4research/client-runtime/state/skills";
import { connectionAtomRuntime } from "../../connection/runtime";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, usePreparedConnection } from "../../state/session";
import { D4AgentControls } from "./D4AgentControls";
import { NiaMcpServerList } from "./NiaMcpServerList";
import { ModelPickerSheet } from "./PickerSheet";
import { useAtomValue } from "@effect/atom-react";
import {
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  resolveD4AgentTaskModelSelection,
  supportsD4AgentDriver,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  monitorActivityThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "@d4research/client-runtime/state/agent-monitor";
import { useLinkTo } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { AppState, Linking, Pressable, View } from "react-native";
import * as Effect from "effect/Effect";
import { AppText as Text } from "../../components/ui/AppText";
import { formatModelSelectionLabel } from "@d4research/client-runtime/state/provider-instance-display";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

async function readNotificationPermission(): Promise<string> {
  const result = await Notifications.getPermissionsAsync().catch(() => null);
  if (result === null) return "Notification permission unavailable";
  if (result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL)
    return "Notifications: provisional";
  return result.granted ? "Notifications: allowed" : "Notifications: not allowed";
}

const skillsInventoryAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      return prepared === null ? Effect.never : fetchEnvironmentSkillsInventory({ prepared });
    })
    .pipe(Atom.withLabel(`mobile-nia-skills:${environmentId}`)),
);

export function AgentMonitorSettings() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  return (
    <View className="gap-4">
      {selectedProjectKey !== null ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Choose an environment to configure Nia.
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
  const state = useD4AgentState(target.environmentId);
  const prepared = usePreparedConnection(target.environmentId);
  const connection = prepared._tag === "Some" ? prepared.value : null;
  const [setup, setSetup] = useState<ReadonlySet<string>>(() => new Set());
  const skillsQuery = useEnvironmentQuery(skillsInventoryAtom(target.environmentId));
  const inventory =
    connection && skillsQuery.data
      ? [
          ...new Map(
            skillsQuery.data.skills
              .filter((skill) => skill.kind === "skill")
              .map((skill) => [skill.name, skill]),
          ).values(),
        ]
      : null;
  const inventoryError = skillsQuery.error ? "Could not load installed skills." : null;
  const config = useEnvironmentServerConfig(target.environmentId);
  const linkTo = useLinkTo();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"manager" | "task" | null>(null);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState("Checking notification permission…");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to native app activation to refresh notification permission changed in system settings.
  useEffect(() => {
    let active = true;
    const readPermission = () => {
      void readNotificationPermission().then((label) => {
        if (active) setPermissionState(label);
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
  const taskSelection = resolveD4AgentTaskModelSelection(agent);
  // Text-only providers cannot enforce the agent's tool allowlist, so they are not offered.
  const groups = groupByProvider(
    buildModelOptions(config, agent.modelSelection, undefined, null).filter((option) =>
      supportsD4AgentDriver(option.providerDriver),
    ),
  );
  const taskGroups = groupByProvider(buildModelOptions(config, taskSelection, undefined, null));
  const monitored = threads.filter(
    (thread) =>
      thread.environmentId === target.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.source.agentMonitor,
  );
  const attention = monitorAttentionThreads(monitored);
  const activity = monitorActivityThreads(monitored);
  const threadRow = (thread: (typeof monitored)[number]) => (
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
  );
  const listCount = (count: number) =>
    count > AGENT_MONITOR_LIST_LIMIT ? `${AGENT_MONITOR_LIST_LIMIT}/${count}` : String(count);
  const save = async (patch: ServerSettingsPatch) => {
    if (saving || !allowed) return;
    setSaving(true);
    setSaveError(null);
    await updateSettings({ environmentId: target.environmentId, input: { patch } })
      .then((result) => {
        if (result._tag === "Failure") setSaveError("Could not save Nia settings.");
      })
      .catch(() => setSaveError("Could not save Nia settings."))
      .finally(() => setSaving(false));
  };
  const write = (patch: Partial<ServerSettings["agentMonitor"]>) =>
    save({ agentMonitor: { ...monitor, ...patch } });
  const writeAgent = (patch: Partial<ServerSettings["d4Agent"]>) =>
    save({ d4Agent: { ...agent, ...patch } });
  const skills = target.serverConfig.settings.skills;
  const writeSkills = async (name: string, enabled: boolean) => {
    if (enabled && skills.enabledForNia.length >= ENABLED_BY_DEFAULT_SKILL_MAX_COUNT) return;
    await save({
      skills: {
        enabledForNia: enabled
          ? [...skills.enabledForNia, name]
          : skills.enabledForNia.filter((item) => item !== name),
      },
    });
  };
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const permission = await Effect.runPromise(
        requestAgentNotificationPermission.pipe(
          Effect.orElseSucceed(() => ({ type: "denied" as const })),
        ),
      );
      if (permission.type !== "granted") {
        setPermissionMessage("Allow notifications in device settings to receive monitor alerts.");
        return;
      }
    }
    setPermissionMessage(null);
    if (enabled) setPermissionState(await readNotificationPermission());
    await write({ notificationsEnabled: enabled });
  };
  return (
    <View className="gap-3">
      <SettingsSection title={`Nia · ${target.label}`}>
        <SettingsSwitchRow
          icon="bubble.left"
          label="Enable Nia"
          value={agent.enabled}
          disabled={!allowed || saving}
          onValueChange={(enabled) => void writeAgent({ enabled })}
        />
        <SettingsRow
          icon="gearshape"
          label="Nia model"
          value={
            agent.modelSelection
              ? formatModelSelectionLabel(config?.providers, agent.modelSelection)
              : "Choose model"
          }
          disabled={!allowed || saving}
          onPress={() => setPicker("manager")}
        />
        <D4AgentControls
          environmentId={target.environmentId}
          agent={agent}
          monitor={monitor}
          config={config}
          disabled={!allowed || saving}
          writeAgent={writeAgent}
          writeMonitor={write}
          state={state}
          section="nia"
        />
        <SettingsRow
          icon="hammer"
          label="Task model"
          value={formatModelSelectionLabel(config?.providers, taskSelection)}
          disabled={!allowed || saving}
          onPress={() => setPicker("task")}
        />
      </SettingsSection>
      <SettingsSection title="MCP servers">
        {NIA_SERVERS.map((server) => (
          <View key={server.id}>
            {server.accessField ? (
              <SettingsSwitchRow
                icon="gearshape"
                label={server.title}
                subtitle={server.description}
                value={agent[server.accessField]}
                disabled={!allowed || saving}
                onValueChange={(enabled) => void writeAgent({ [server.accessField]: enabled })}
              />
            ) : (
              <View className="gap-1 px-4 py-3">
                <Text className="text-base text-foreground">{server.title}</Text>
                <Text className="text-sm text-foreground-muted">{server.description}</Text>
                <Text className="text-sm text-foreground-muted">
                  {server.id === "threads"
                    ? "Always on"
                    : agent.toolGuardUrl
                      ? "Configured"
                      : "Not configured"}
                </Text>
              </View>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${server.title} setup`}
              accessibilityState={{ expanded: setup.has(server.id) }}
              className="px-4 py-3"
              onPress={() =>
                setSetup((current) => {
                  const next = new Set(current);
                  if (next.has(server.id)) next.delete(server.id);
                  else next.add(server.id);
                  return next;
                })
              }
            >
              <Text className="text-base text-accent">
                {setup.has(server.id) ? "Setup ▴" : "Setup ▾"}
              </Text>
            </Pressable>
            {setup.has(server.id) ? (
              <D4AgentControls
                environmentId={target.environmentId}
                agent={agent}
                monitor={monitor}
                config={config}
                disabled={!allowed || saving}
                writeAgent={writeAgent}
                writeMonitor={write}
                state={state}
                section={server.id}
              >
                {server.id === "threads" ? (
                  <>
                    <SettingsSwitchRow
                      icon="bolt.circle"
                      label="Monitor threads"
                      value={monitor.enabled}
                      disabled={!allowed || saving}
                      onValueChange={(enabled) => void write({ enabled })}
                    />

                    <SettingsSwitchRow
                      icon="bell.badge"
                      label="Attention notifications"
                      value={monitor.notificationsEnabled}
                      disabled={!allowed || saving}
                      onValueChange={(enabled) => void toggleNotifications(enabled)}
                    />

                    <Text className="px-4 py-3 text-sm text-foreground-muted">
                      {permissionState}
                    </Text>
                    {permissionMessage ? (
                      <Text
                        accessibilityRole="alert"
                        className="px-4 py-3 text-sm text-foreground-muted"
                      >
                        {permissionMessage}
                      </Text>
                    ) : null}
                    {monitor.enabled ? (
                      <View>
                        <Text className="px-4 py-3 text-base text-foreground">{`Needs attention · ${listCount(attention.length)}`}</Text>
                        {attention.length === 0 ? (
                          <Text className="p-4 text-sm text-foreground-muted">
                            No threads need attention.
                          </Text>
                        ) : (
                          attention.slice(0, AGENT_MONITOR_LIST_LIMIT).map(threadRow)
                        )}
                      </View>
                    ) : null}
                    {monitor.enabled && activity.length > 0 ? (
                      <View>
                        <Text className="px-4 py-3 text-base text-foreground">{`Thread activity · ${listCount(activity.length)}`}</Text>
                        {activity.slice(0, AGENT_MONITOR_LIST_LIMIT).map(threadRow)}
                      </View>
                    ) : null}
                  </>
                ) : null}
                {server.id === "toolGuard" ? (
                  <SettingsRow
                    icon="gearshape"
                    label="Open Tool Guard settings"
                    disabled={!connection}
                    onPress={() => {
                      if (connection)
                        void Linking.openURL(
                          new URL("/settings/tool-guard", connection.httpBaseUrl).toString(),
                        ).catch(() => setSaveError("Could not open Tool Guard settings."));
                    }}
                  />
                ) : null}
              </D4AgentControls>
            ) : null}
          </View>
        ))}
        <NiaMcpServerList
          servers={agent.mcpServers}
          permissionMode={agent.permissionMode}
          disabled={!allowed || saving}
          save={(mcpServers) => writeAgent({ mcpServers })}
        />
      </SettingsSection>
      <SettingsSection title="Skills">
        <Text className="px-4 py-3 text-sm text-foreground-muted">{`Enable up to ${ENABLED_BY_DEFAULT_SKILL_MAX_COUNT} installed skills for Nia. Skills do not grant tool permissions.`}</Text>
        {inventoryError ? (
          <Text accessibilityRole="alert" className="px-4 py-3 text-sm text-foreground-muted">
            {inventoryError}
          </Text>
        ) : inventory === null ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            {connection ? "Loading installed skills…" : "Connect to load installed skills."}
          </Text>
        ) : inventory.length === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">No installed skills.</Text>
        ) : (
          inventory.map((skill) => (
            <SettingsSwitchRow
              key={skill.name}
              icon="gearshape"
              label={skill.name}
              subtitle={skill.description}
              value={skills.enabledForNia.includes(skill.name)}
              disabled={
                !allowed ||
                saving ||
                (!skills.enabledForNia.includes(skill.name) &&
                  skills.enabledForNia.length >= ENABLED_BY_DEFAULT_SKILL_MAX_COUNT)
              }
              onValueChange={(enabled) => void writeSkills(skill.name, enabled)}
            />
          ))
        )}
        {inventory !== null
          ? skills.enabledForNia
              .filter((name) => !inventory.some((skill) => skill.name === name))
              .map((name) => (
                <SettingsSwitchRow
                  key={name}
                  icon="gearshape"
                  label={name}
                  subtitle="Not installed"
                  value={true}
                  disabled={!allowed || saving}
                  onValueChange={(enabled) => {
                    if (!enabled) void writeSkills(name, false);
                  }}
                />
              ))
          : null}
      </SettingsSection>
      {saveError ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground-muted">
          {saveError}
        </Text>
      ) : null}
      <ModelPickerSheet
        title={picker === "task" ? "Task model" : "Nia model"}
        visible={picker !== null}
        groups={picker === "task" ? taskGroups : groups}
        selected={picker === "task" ? taskSelection : agent.modelSelection}
        onSelect={(option) => {
          void writeAgent(
            picker === "task"
              ? { taskModelSelection: option.selection }
              : { modelSelection: option.selection },
          );
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}
