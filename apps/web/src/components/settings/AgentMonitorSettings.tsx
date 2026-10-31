import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  supportsD4AgentDriver,
  type ModelSelection,
  type ServerSettings,
} from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  monitorActivityThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "@d4research/client-runtime/state/agent-monitor";
import { createModelSelection } from "@d4research/shared/model";
import { useState } from "react";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { D4AgentControls } from "./D4AgentControls";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

export function AgentMonitorSettings() {
  const { environment, scope } = useSettingsScope();
  return scope.kind === "environment" && environment?.serverConfig ? (
    <AgentMonitorForm key={environment.environmentId} />
  ) : (
    <SettingsSection title="Nia">
      <SettingsScopeNotice target="environment">
        Choose one environment to configure Nia.
      </SettingsScopeNotice>
    </SettingsSection>
  );
}

function AgentMonitorForm() {
  const { environment } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const threads = useThreadShells();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const environmentId = environment?.environmentId ?? null;
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const settings = useScopedSettings();
  if (!settings || !environmentId) return null;
  const monitor = settings.agentMonitor;
  if (!monitor)
    return (
      <SettingsSection title="Nia">
        <p className="text-sm text-muted-foreground">This environment does not support Nia.</p>
      </SettingsSection>
    );
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const agent = settings.d4Agent;
  const fallbackSelection = resolveAppModelSelectionState(settings, providers);
  const selection = agent.modelSelection ?? fallbackSelection;
  const taskSelection = agent.taskModelSelection ?? fallbackSelection;
  // Text-only providers cannot enforce the agent's tool allowlist, so they are not offered.
  const allEntries = providerInstanceEntriesFor(providers, settings, null);
  const entries = allEntries.filter((entry) => supportsD4AgentDriver(entry.driverKind));
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const taskModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    taskSelection.instanceId,
    taskSelection.model,
  );
  const monitored = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.source.agentMonitor,
  );
  const attention = monitorAttentionThreads(monitored);
  const activity = monitorActivityThreads(monitored);
  const listCount = (count: number) =>
    count > AGENT_MONITOR_LIST_LIMIT ? `${AGENT_MONITOR_LIST_LIMIT}/${count}` : String(count);
  const write = async (patch: Partial<ServerSettings["agentMonitor"]>) => {
    if (!allowed || saving) return;
    setSaving(true);
    setSaveError(null);
    await updateSettings({
      environmentId,
      input: { patch: { agentMonitor: { ...monitor, ...patch } } },
    })
      .then((result) => {
        if (result._tag === "Failure") setSaveError("Could not save Nia settings.");
      })
      .catch(() => setSaveError("Could not save Nia settings."))
      .finally(() => setSaving(false));
  };
  const writeAgent = async (patch: Partial<ServerSettings["d4Agent"]>) => {
    if (!allowed || saving) return;
    setSaving(true);
    setSaveError(null);
    await updateSettings({ environmentId, input: { patch: { d4Agent: { ...agent, ...patch } } } })
      .then((result) => {
        if (result._tag === "Failure") setSaveError("Could not save Nia settings.");
      })
      .catch(() => setSaveError("Could not save Nia settings."))
      .finally(() => setSaving(false));
  };
  const saveModel = (modelSelection: ModelSelection | null) => void writeAgent({ modelSelection });
  const saveTaskModel = (taskModelSelection: ModelSelection | null) =>
    void writeAgent({ taskModelSelection });
  return (
    <SettingsSection title="Nia" id="agent-monitor">
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      <SettingsRow
        title="Monitor threads"
        description="Classifies thread activity locally without model calls."
        control={
          <Switch
            aria-label="Monitor threads"
            checked={monitor.enabled}
            disabled={!allowed || saving}
            onCheckedChange={(enabled) => void write({ enabled: Boolean(enabled) })}
          />
        }
      />
      <SettingsRow
        title="Enable Nia"
        description="Show Nia in the sidebar and allow agent chat about threads and host health."
        control={
          <Switch
            aria-label="Enable Nia"
            checked={agent.enabled}
            disabled={!allowed || saving}
            onCheckedChange={(enabled) => void writeAgent({ enabled: Boolean(enabled) })}
          />
        }
      />
      <SettingsRow
        title="Agent model"
        description="Uses the live provider catalog. An unavailable model keeps Nia off."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Nia model"
              {...(agent.modelSelection ? {} : { triggerLabel: "Choose model" })}
              disabled={!allowed || saving}
              onInstanceModelChange={(instanceId, model) =>
                saveModel(createModelSelection(instanceId, model))
              }
            />
            {agent.modelSelection ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!allowed || saving}
                onClick={() => saveModel(null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Task model"
        description="Default provider and model for new tasks. Nia never substitutes its manager model."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={taskSelection.instanceId}
              model={taskSelection.model}
              lockedProvider={null}
              instanceEntries={allEntries}
              modelOptionsByInstance={taskModelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Nia task model"
              {...(agent.taskModelSelection ? {} : { triggerLabel: "Choose model" })}
              disabled={!allowed || saving}
              onInstanceModelChange={(instanceId, model) =>
                saveTaskModel(createModelSelection(instanceId, model))
              }
            />
            {agent.taskModelSelection ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!allowed || saving}
                onClick={() => saveTaskModel(null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Attention notifications"
        description="Allow connected clients to notify you when a thread needs attention. System alerts require device notification permission."
        control={
          <Switch
            aria-label="Monitor attention notifications"
            checked={monitor.notificationsEnabled}
            disabled={!allowed || saving}
            onCheckedChange={(enabled) => void write({ notificationsEnabled: Boolean(enabled) })}
          />
        }
      />
      <D4AgentControls
        agent={agent}
        monitor={monitor}
        disabled={!allowed || saving}
        writeAgent={writeAgent}
        writeMonitor={write}
        environmentId={environmentId}
      />
      {monitor.enabled ? (
        <div className="space-y-2 py-3">
          <p className="text-sm font-medium">Needs attention · {listCount(attention.length)}</p>
          {attention.length === 0 ? (
            <p className="text-sm text-muted-foreground">No threads need attention.</p>
          ) : (
            attention.slice(0, AGENT_MONITOR_LIST_LIMIT).map((thread) => (
              <Link
                key={thread.id}
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.id }}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
              >
                <span className="truncate">{thread.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {agentMonitorLabel(thread.source.agentMonitor!)}
                </span>
              </Link>
            ))
          )}
          <p className="pt-2 text-sm font-medium">Thread activity · {listCount(activity.length)}</p>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting for thread activity.</p>
          ) : (
            activity.slice(0, AGENT_MONITOR_LIST_LIMIT).map((thread) => (
              <Link
                key={thread.id}
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.id }}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
              >
                <span className="truncate">{thread.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {agentMonitorLabel(thread.source.agentMonitor!)}
                </span>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </SettingsSection>
  );
}
