import type { NiaServerId } from "@d4research/client-runtime/niaServers";
import { D4AgentSessions } from "../agent-awareness/D4AgentSessions";
import type { useD4AgentState } from "../agent-awareness/useD4AgentState";
import * as Arr from "effect/Array";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  brainIndexStatus,
} from "../agent-awareness/d4AgentPresentation";
import { formatQuietHour, parseQuietHour } from "./d4AgentSettings.logic";
import {
  D4_BRAIN_CONTEXTS,
  type EnvironmentId,
  type ServerSettings,
  type ServerConfig,
} from "@d4research/contracts";
import { getProviderOptionDescriptors } from "@d4research/shared/model";
import { useState, type ComponentProps, type ReactNode } from "react";
import { View, TextInput, Modal, Pressable, ScrollView } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
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
  section,
  state,
  children,
}: {
  agent: Agent;
  monitor: Monitor;
  config: ServerConfig | null;
  disabled: boolean;
  writeAgent: (patch: Partial<Agent>) => Promise<void>;
  writeMonitor: (patch: Partial<Monitor>) => Promise<void>;
  environmentId: EnvironmentId;
  section: "nia" | NiaServerId;
  state: ReturnType<typeof useD4AgentState>;
  children?: ReactNode;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
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
  if (section === "nia")
    return (
      <>
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
      </>
    );
  if (section === "host")
    return (
      <>
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
      </>
    );
  if (section === "memory" || section === "cto" || section === "toolGuard")
    return (
      <>
        {(section === "memory"
          ? (["brainVaultPath", "embeddingBaseUrl", "embeddingModel"] as const)
          : section === "cto"
            ? (["ctoBaseUrl"] as const)
            : (["toolGuardUrl"] as const)
        ).map((field) => {
          const label = {
            brainVaultPath: "Brain vault path",
            embeddingBaseUrl: "Embedding base URL",
            embeddingModel: "Embedding model",
            ctoBaseUrl: "CTO base URL",
            toolGuardUrl: "Tool Guard URL",
          }[field];
          const inherits = field === "embeddingBaseUrl" || field === "embeddingModel";
          return (
            <View key={field} className="gap-2 px-4 py-3">
              <Text className="text-base text-foreground">{label}</Text>
              <TextInput
                accessibilityLabel={label}
                key={agent[field] ?? ""}
                defaultValue={agent[field] ?? ""}
                editable={!disabled}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={inherits ? "Inherit from Second Brain" : undefined}
                className="rounded border border-border px-3 py-2 text-foreground"
                onEndEditing={(event) => {
                  const value = event.nativeEvent.text.trim();
                  if (value !== (agent[field] ?? ""))
                    void writeAgent({
                      [field]: (inherits || field === "toolGuardUrl") && !value ? null : value,
                    });
                }}
              />
              {inherits ? (
                <Text className="text-sm text-foreground-muted">
                  Leave blank to use the Second Brain embedding setting.
                </Text>
              ) : null}
            </View>
          );
        })}

        {section === "memory" ? (
          <>
            <SettingsSwitchRow
              icon="gearshape"
              label="Brain embeddings"
              value={agent.embeddingsEnabled}
              disabled={disabled}
              onValueChange={(embeddingsEnabled) => void writeAgent({ embeddingsEnabled })}
            />
            {D4_BRAIN_CONTEXTS.map((context) => {
              const index = state.data?.brainIndexes.find((item) => item.context === context);
              return (
                <Text key={context} className="px-4 py-2 text-sm text-foreground-muted">
                  Brain index · {context}:{" "}
                  {brainIndexStatus(
                    index ?? { context, status: "not-available", files: 0, lastRebuild: null },
                  )}
                </Text>
              );
            })}
          </>
        ) : null}
        {children}
      </>
    );
  if (section !== "threads") return null;
  return (
    <>
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
        Read-only observes. Ask requires approval for each action. Act sets reminders, submits
        memory proposals for review, and asks CTO questions when enabled for the selected context.
        Sending, starting threads, interrupting, answering, commands and schedules always require
        your approval. Provider permission approvals remain manual.
      </Text>

      {projects.map((project) => (
        <AgentChoiceRow
          key={project.id}
          icon="gearshape"
          label={`Context · ${project.title}`}
          value={agent.projectContexts[project.id] ?? ""}
          disabled={disabled}
          options={[
            { id: "", label: "Unmapped" },
            ...(agent.projectContexts[project.id] === "Global"
              ? [{ id: "Global", label: "Global (mapped)" }]
              : []),
            ...D4_BRAIN_CONTEXTS.filter((context) => context !== "Global").map((context) => ({
              id: context,
              label: context,
            })),
          ]}
          onChange={(value) => {
            const context = D4_BRAIN_CONTEXTS.find((item) => item === value);
            const projectContexts = Object.fromEntries(
              Object.entries(agent.projectContexts).filter(([id]) => id !== project.id),
            );
            if (context) projectContexts[project.id] = context;
            void writeAgent({ projectContexts });
          }}
        />
      ))}
      {(["dev", "research"] as const).flatMap((kind) =>
        (config?.settings[kind].scenarios ?? []).map((pipeline) => {
          const id = `${kind}:${pipeline.name}`;
          return (
            <AgentChoiceRow
              key={id}
              icon="gearshape"
              label={`Pipeline project · ${id}`}
              disabled={disabled}
              value={agent.pipelineProjects[id] ?? ""}
              options={[
                { id: "", label: "Unmapped" },
                ...projects.map((project) => ({ id: project.id, label: project.title })),
              ]}
              onChange={(value) => {
                const pipelineProjects = { ...agent.pipelineProjects };
                const project = projects.find((item) => item.id === value);
                if (project) pipelineProjects[id] = project.id;
                else delete pipelineProjects[id];
                void writeAgent({ pipelineProjects });
              }}
            />
          );
        }),
      )}

      <AgentChoiceRow
        icon="clock"
        label="Agent thread auto-archive"
        value={String(agent.agentThreadArchiveHours ?? "off")}
        disabled={disabled}
        options={[
          { id: "off", label: "Off" },
          { id: "0", label: "On success" },
          { id: "24", label: "24 hours" },
        ]}
        onChange={(selected) =>
          void writeAgent({
            agentThreadArchiveHours: selected === "24" ? 24 : selected === "0" ? 0 : null,
          })
        }
      />
      <Text className="px-4 pb-3 text-sm text-foreground-muted">
        Archive completed agent-started threads once reported, or 24 hours later. Replies, pins,
        pending questions, and linked pull requests prevent archiving.
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
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
            24-hour time. Uses the device time zone saved when enabled, with its UTC offset as a fallback.
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

      <D4AgentSessions
        environmentId={environmentId}
        sessions={state.data?.openSessions ?? []}
        refresh={state.refresh}
      />

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

      {children}
      {state.error ? (
        <Text accessibilityRole="alert" className="px-4 py-3 text-sm text-foreground-muted">
          {state.error}
        </Text>
      ) : null}
    </>
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
