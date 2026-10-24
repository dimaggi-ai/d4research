import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { ModelSelection, ServerSettings } from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
} from "@d4research/client-runtime/state/agent-monitor";
import { createModelSelection } from "@d4research/shared/model";
import { useState } from "react";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deriveProviderInstanceEntries,
  applyProviderInstanceSettings,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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
    <SettingsSection title="Monitor">
      <SettingsScopeNotice target="environment">
        Choose one environment to configure its monitor.
      </SettingsScopeNotice>
    </SettingsSection>
  );
}

function AgentMonitorForm() {
  const { environment } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const threads = useThreadShells();
  const [saving, setSaving] = useState(false);
  const environmentId = environment?.environmentId ?? null;
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const settings = useScopedSettings();
  if (!settings || !environmentId) return null;
  const monitor = settings.agentMonitor;
  if (!monitor)
    return (
      <SettingsSection title="Monitor">
        <p className="text-sm text-muted-foreground">
          This environment does not support the monitor.
        </p>
      </SettingsSection>
    );
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const selection = monitor.modelSelection ?? resolveAppModelSelectionState(settings, providers);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const monitored = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.source.agentMonitor,
  );
  const attention = monitorAttentionThreads(monitored);
  const write = async (patch: Partial<ServerSettings["agentMonitor"]>) => {
    if (!allowed || saving) return;
    setSaving(true);
    try {
      await updateSettings({
        environmentId,
        input: { patch: { agentMonitor: { ...monitor, ...patch } } },
      });
    } finally {
      setSaving(false);
    }
  };
  const saveModel = (modelSelection: ModelSelection | null) => void write({ modelSelection });
  return (
    <SettingsSection title="Monitor" id="agent-monitor">
      <SettingsRow
        title="Monitor threads"
        description="Classifies thread activity locally. No model calls or automatic recovery actions."
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
        title="Saved model"
        description="Stores a provider and model for this environment. The monitor uses deterministic rules; this selection does not start a model or change running threads."
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
              triggerAriaLabel="Saved monitor model"
              {...(monitor.modelSelection ? {} : { triggerLabel: "Choose model" })}
              disabled={!allowed || saving}
              onInstanceModelChange={(instanceId, model) =>
                saveModel(createModelSelection(instanceId, model))
              }
            />
            {monitor.modelSelection ? (
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
        title="Attention notifications"
        description="Allow connected clients to notify you when a thread needs attention. Device notification permission is also required."
        control={
          <Switch
            aria-label="Monitor attention notifications"
            checked={monitor.notificationsEnabled}
            disabled={!allowed || saving}
            onCheckedChange={(enabled) => void write({ notificationsEnabled: Boolean(enabled) })}
          />
        }
      />
      {monitor.enabled ? (
        <div className="space-y-2 py-3">
          <p className="text-sm font-medium">Needs attention · {attention.length}</p>
          {attention.length === 0 ? (
            <p className="text-sm text-muted-foreground">No threads need attention.</p>
          ) : (
            attention.map((thread) => (
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
          <p className="pt-2 text-sm font-medium">Thread activity</p>
          {monitored.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting for thread activity.</p>
          ) : (
            monitored
              .filter((thread) => !thread.source.agentMonitor?.attentionRequired)
              .map((thread) => (
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
