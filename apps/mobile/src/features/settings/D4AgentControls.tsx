import * as Arr from "effect/Array";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
} from "../agent-awareness/d4AgentPresentation";
import { formatQuietHour, parseQuietHour } from "./d4AgentSettings.logic";
import type { EnvironmentId, ServerSettings, ServerConfig } from "@d4research/contracts";
import { getProviderOptionDescriptors } from "@d4research/shared/model";
import { useState, type ComponentProps } from "react";
import { View, TextInput, Modal, Pressable, ScrollView } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type Agent = ServerSettings["d4Agent"];
type Monitor = ServerSettings["agentMonitor"];
const classes = ["waiting", "stuck", "auth", "failed", "completed", "system"] as const;
const labels = {
  waiting: "Waiting for input",
  stuck: "Stuck threads",
  auth: "Authentication required",
  failed: "Failed runs",
  completed: "Completed runs",
  system: "System issues",
};
export function D4AgentControls({
  agent,
  monitor,
  config,
  disabled,
  writeAgent,
  writeMonitor,
  environmentId,
}: {
  agent: Agent;
  monitor: Monitor;
  config: ServerConfig | null;
  disabled: boolean;
  writeAgent: (patch: Partial<Agent>) => Promise<void>;
  writeMonitor: (patch: Partial<Monitor>) => Promise<void>;
  environmentId: EnvironmentId;
}) {
  const state = useEnvironmentQuery(serverEnvironment.d4AgentState({ environmentId, input: {} }));
  const provider = config?.providers.find(
    (item) => item.instanceId === agent.modelSelection?.instanceId,
  );
  const model = provider?.models.find((item) => item.slug === agent.modelSelection?.model);
  const descriptors = model?.capabilities
    ? getProviderOptionDescriptors({
        caps: model.capabilities,
        selections: agent.modelSelection?.options,
      })
    : [];
  const numeric = (
    label: string,
    value: number,
    min: number,
    max: number,
    save: (value: number) => void,
  ) => (
    <View className="flex-row items-center justify-between gap-3 px-4 py-3">
      <Text className="flex-1 text-base text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardType="number-pad"
        className="min-w-16 rounded border border-border px-3 py-2 text-foreground"
        editable={!disabled}
        defaultValue={String(value)}
        key={`${label}:${value}`}
        onEndEditing={(event) => {
          const next = Number(event.nativeEvent.text);
          if (Number.isInteger(next) && next >= min && next <= max) save(next);
        }}
      />
    </View>
  );
  return (
    <SettingsSection title="Agent behavior">
      {agent.enabled && state.data && !state.data.modelAvailable ? (
        <Text accessibilityRole="alert" className="px-4 py-3 text-sm text-foreground-muted">
          {agentUnavailableMessage(state.data.unavailableReason)}
        </Text>
      ) : null}
      {descriptors
        .filter((descriptor) => descriptor.type === "select")
        .map((descriptor) => (
          <AgentChoiceRow
            key={descriptor.id}
            icon="gearshape"
            label={descriptor.label}
            value={String(
              agent.modelSelection?.options?.find((item) => item.id === descriptor.id)?.value ??
                descriptor.currentValue ??
                "",
            )}
            options={[{ id: "", label: "Provider default" }, ...descriptor.options]}
            disabled={disabled}
            onChange={(value) => {
              if (agent.modelSelection)
                void writeAgent({
                  modelSelection: {
                    ...agent.modelSelection,
                    options: [
                      ...(agent.modelSelection.options ?? []).filter(
                        (item) => item.id !== descriptor.id,
                      ),
                      ...(value ? [{ id: descriptor.id, value }] : []),
                    ],
                  },
                });
            }}
          />
        ))}
      <AgentChoiceRow
        icon="gearshape"
        label="Permission level"
        value={agent.permissionMode}
        disabled={disabled}
        options={[
          { id: "read-only", label: "Read-only" },
          { id: "ask", label: "Ask" },
          { id: "act", label: "Act" },
        ]}
        onChange={(value) => {
          if (value === "read-only" || value === "ask" || value === "act")
            void writeAgent({ permissionMode: value });
        }}
      />
      <Text className="px-4 pb-3 text-sm text-foreground-muted">
        Read-only observes. Ask requires each action to be approved. Act allows interruption and
        input answers, but sending messages and starting threads still require confirmation.
        Provider permission approvals remain manual.
      </Text>
      <AgentChoiceRow
        icon="clock"
        label="Heartbeat"
        value={String(agent.heartbeatMinutes ?? "off")}
        disabled={disabled}
        options={[
          { id: "off", label: "Off" },
          ...[15, 30, 60].map((value) => ({ id: String(value), label: `${value} minutes` })),
        ]}
        onChange={(selected) => {
          const value = Number(selected);
          void writeAgent({
            heartbeatMinutes: value === 15 || value === 30 || value === 60 ? value : null,
          });
        }}
      />
      <SettingsSwitchRow
        icon="moon"
        label="Quiet hours"
        value={agent.quietHours !== null}
        disabled={disabled}
        onValueChange={(enabled) =>
          void writeAgent({
            quietHours: enabled
              ? {
                  startMinute: 1320,
                  endMinute: 480,
                  utcOffsetMinutes: -new Date().getTimezoneOffset(),
                }
              : null,
          })
        }
      />
      {agent.quietHours ? (
        <>
          {(["startMinute", "endMinute"] as const).map((key) => (
            <View key={key} className="flex-row items-center justify-between gap-3 px-4 py-3">
              <Text className="text-base text-foreground">
                {key === "startMinute" ? "Quiet hours start" : "Quiet hours end"}
              </Text>
              <TextInput
                accessibilityLabel={key === "startMinute" ? "Quiet hours start" : "Quiet hours end"}
                placeholder="HH:MM"
                keyboardType="numbers-and-punctuation"
                className="min-w-20 rounded border border-border px-3 py-2 text-foreground"
                editable={!disabled}
                defaultValue={formatQuietHour(agent.quietHours![key])}
                onEndEditing={(event) => {
                  const minute = parseQuietHour(event.nativeEvent.text);
                  if (minute !== null && agent.quietHours)
                    void writeAgent({ quietHours: { ...agent.quietHours, [key]: minute } });
                }}
              />
            </View>
          ))}
          <Text className="px-4 pb-3 text-sm text-foreground-muted">
            24-hour time. Uses the device UTC offset saved when enabled.
          </Text>
        </>
      ) : null}
      {numeric(
        "Stuck threshold minutes",
        monitor.stuckAfterMinutes,
        1,
        240,
        (stuckAfterMinutes) => void writeMonitor({ stuckAfterMinutes }),
      )}
      {classes.map((kind) => (
        <SettingsSwitchRow
          key={kind}
          icon="bell.badge"
          label={labels[kind]}
          value={monitor.notifyClasses.includes(kind)}
          disabled={disabled}
          onValueChange={(enabled) =>
            void writeMonitor({
              notifyClasses: enabled
                ? [...monitor.notifyClasses, kind]
                : monitor.notifyClasses.filter((value) => value !== kind),
            })
          }
        />
      ))}
      <SettingsSwitchRow
        icon="gearshape"
        label="System probes"
        value={agent.systemProbeEnabled}
        disabled={disabled}
        onValueChange={(systemProbeEnabled) => void writeAgent({ systemProbeEnabled })}
      />
      {numeric(
        "Disk warning percent",
        agent.diskWarningPercent,
        50,
        99,
        (diskWarningPercent) => void writeAgent({ diskWarningPercent }),
      )}
      {state.data?.systemHealth.map((check) => (
        <Text key={check.id} className="px-4 py-2 text-sm text-foreground-muted">
          {systemCheckLabel(check)}: {systemCheckStatus(check)}
        </Text>
      ))}
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        Local token usage · {state.data?.usage.length ?? 0} recorded turns
      </Text>
      {Arr.reverse(state.data?.usage.slice(-5) ?? []).map((turn) => (
        <Text key={turn.runId} className="px-4 pb-3 text-xs text-foreground-muted">
          {turn.attributes["gen_ai.request.model"]} · input{" "}
          {turn.attributes["gen_ai.usage.input_tokens"] ?? "unavailable"} · output{" "}
          {turn.attributes["gen_ai.usage.output_tokens"] ?? "unavailable"} · cache read{" "}
          {turn.attributes["gen_ai.usage.cache_read.input_tokens"] ?? "unavailable"} · cache write{" "}
          {turn.attributes["gen_ai.usage.cache_creation.input_tokens"] ?? "unavailable"}
        </Text>
      ))}
      {state.error ? (
        <Text accessibilityRole="alert" className="px-4 py-3 text-sm text-foreground-muted">
          {state.error}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function AgentChoiceRow({
  icon,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  icon: ComponentProps<typeof SettingsRow>["icon"];
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        icon={icon}
        label={label}
        value={options.find((option) => option.id === value)?.label ?? value}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-background pt-6">
          <View className="flex-row items-center justify-between px-5 pb-4">
            <Text className="text-lg font-t3-semibold text-foreground">{label}</Text>
            <Pressable accessibilityRole="button" className="p-2" onPress={() => setOpen(false)}>
              <Text className="text-accent">Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-2 px-5 pb-10">
            {options.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: value === option.id }}
                className="rounded-xl bg-surface px-4 py-4"
                onPress={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
              >
                <Text className="text-base text-foreground">
                  {option.label}
                  {value === option.id ? " ✓" : ""}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
