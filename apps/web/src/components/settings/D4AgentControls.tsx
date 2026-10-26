import { D4AgentSessions } from "../agent/D4AgentSessions";
import { useD4AgentState } from "../agent/useD4AgentState";
import { withAgentModelOption } from "./D4AgentControls.logic";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  brainIndexStatus,
} from "../agent/d4AgentPresentation";
import { D4_BRAIN_CONTEXTS, type EnvironmentId, type ServerSettings } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { getProviderOptionDescriptors } from "@d4research/shared/model";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

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
  disabled,
  writeAgent,
  writeMonitor,
  environmentId,
}: {
  agent: Agent;
  monitor: Monitor;
  disabled: boolean;
  writeAgent: (patch: Partial<Agent>) => Promise<void>;
  writeMonitor: (patch: Partial<Monitor>) => Promise<void>;
  environmentId: EnvironmentId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useD4AgentState(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const selectedProvider = config?.providers.find(
    (provider) => provider.instanceId === agent.modelSelection?.instanceId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.slug === agent.modelSelection?.model,
  );
  const descriptors = selectedModel?.capabilities
    ? getProviderOptionDescriptors({
        caps: selectedModel.capabilities,
        selections: agent.modelSelection?.options,
      })
    : [];
  const selectClass =
    "max-w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline focus-visible:outline-ring";
  const numberInput = (
    value: number,
    min: number,
    max: number,
    label: string,
    save: (value: number) => void,
  ) => (
    <div className="w-24">
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) save(next);
        }}
      />
    </div>
  );
  return (
    <>
      <D4AgentSessions
        environmentId={environmentId}
        sessions={state.data?.openSessions ?? []}
        refresh={state.refresh}
      />
      {agent.enabled && state.data && !state.data.modelAvailable ? (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          {agentUnavailableMessage(state.data.unavailableReason)}
        </p>
      ) : null}
      {descriptors
        .filter((descriptor) => descriptor.type === "select")
        .map((descriptor) => (
          <SettingsRow
            key={descriptor.id}
            title={descriptor.label}
            control={
              <select
                aria-label={`Agent ${descriptor.label}`}
                className={selectClass}
                disabled={disabled || !agent.modelSelection}
                value={String(
                  agent.modelSelection?.options?.find((option) => option.id === descriptor.id)
                    ?.value ??
                    descriptor.currentValue ??
                    "",
                )}
                onChange={(event) => {
                  if (agent.modelSelection)
                    void writeAgent({
                      modelSelection: withAgentModelOption(
                        agent.modelSelection,
                        descriptor.id,
                        event.target.value,
                      ),
                    });
                }}
              >
                <option value="">Provider default</option>
                {descriptor.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            }
          />
        ))}
      {(["brainVaultPath", "embeddingBaseUrl", "embeddingModel", "ctoBaseUrl"] as const).map(
        (field) => {
          const title = {
            brainVaultPath: "Brain vault path",
            embeddingBaseUrl: "Embedding base URL",
            embeddingModel: "Embedding model",
            ctoBaseUrl: "CTO base URL",
          }[field];
          const inherits = field === "embeddingBaseUrl" || field === "embeddingModel";
          return (
            <SettingsRow
              key={field}
              title={title}
              description={
                inherits ? "Leave blank to use the Second Brain embedding setting." : undefined
              }
              control={
                <div className="w-72 max-w-full">
                  <Input
                    aria-label={title}
                    key={agent[field] ?? ""}
                    defaultValue={agent[field] ?? ""}
                    disabled={disabled}
                    placeholder={inherits ? "Inherit from Second Brain" : undefined}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value !== (agent[field] ?? ""))
                        void writeAgent({ [field]: inherits && !value ? null : value });
                    }}
                  />
                </div>
              }
            />
          );
        },
      )}
      {(["memoryEnabled", "embeddingsEnabled", "ctoEnabled"] as const).map((field) => {
        const title = {
          memoryEnabled: "Brain memory",
          embeddingsEnabled: "Brain embeddings",
          ctoEnabled: "CTO agents",
        }[field];
        return (
          <SettingsRow
            key={field}
            title={title}
            control={
              <Switch
                aria-label={title}
                checked={agent[field]}
                disabled={disabled}
                onCheckedChange={(value) => void writeAgent({ [field]: Boolean(value) })}
              />
            }
          />
        );
      })}
      {projects.map((project) => (
        <SettingsRow
          key={project.id}
          title={`Context · ${project.title}`}
          control={
            <select
              aria-label={`Context for ${project.title}`}
              className={selectClass}
              disabled={disabled}
              value={agent.projectContexts[project.id] ?? ""}
              onChange={(event) => {
                const context = D4_BRAIN_CONTEXTS.find((value) => value === event.target.value);
                const projectContexts = Object.fromEntries(
                  Object.entries(agent.projectContexts).filter(([id]) => id !== project.id),
                );
                if (context) projectContexts[project.id] = context;
                void writeAgent({ projectContexts });
              }}
            >
              <option value="">Unmapped</option>
              {agent.projectContexts[project.id] === "Global" ? (
                <option value="Global">Global (mapped)</option>
              ) : null}
              {D4_BRAIN_CONTEXTS.filter((context) => context !== "Global").map((context) => (
                <option key={context} value={context}>
                  {context}
                </option>
              ))}
            </select>
          }
        />
      ))}
      {(["dev", "research"] as const).flatMap((kind) =>
        (config?.settings[kind].scenarios ?? []).map((pipeline) => {
          const id = `${kind}:${pipeline.name}`;
          return (
            <SettingsRow
              key={id}
              title={`Pipeline project · ${id}`}
              control={
                <select
                  aria-label={`Project for ${id}`}
                  className={selectClass}
                  disabled={disabled}
                  value={agent.pipelineProjects[id] ?? ""}
                  onChange={(event) => {
                    const pipelineProjects = { ...agent.pipelineProjects };
                    const project = projects.find((item) => item.id === event.target.value);
                    if (project) pipelineProjects[id] = project.id;
                    else delete pipelineProjects[id];
                    void writeAgent({ pipelineProjects });
                  }}
                >
                  <option value="">Unmapped</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              }
            />
          );
        }),
      )}
      {D4_BRAIN_CONTEXTS.map((context) => {
        const index = state.data?.brainIndexes.find((item) => item.context === context);
        return (
          <SettingsRow
            key={context}
            title={`Brain index · ${context}`}
            control={
              <span className="text-sm text-muted-foreground">
                {brainIndexStatus(
                  index ?? { context, status: "not-available", files: 0, lastRebuild: null },
                )}
              </span>
            }
          />
        );
      })}
      <SettingsRow
        title="Permission level"
        description="Read-only observes. Ask requires approval for each action. Act sets reminders, submits memory proposals for review, and asks CTO questions when enabled for the selected context. Sending, starting threads, interrupting, answering, commands and schedules always require your approval. Provider permission approvals remain manual."
        control={
          <select
            aria-label="Agent permission level"
            className={selectClass}
            disabled={disabled}
            value={agent.permissionMode}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "read-only" || value === "ask" || value === "act")
                void writeAgent({ permissionMode: value });
            }}
          >
            <option value="read-only">Read-only</option>
            <option value="ask">Ask</option>
            <option value="act">Act</option>
          </select>
        }
      />
      <SettingsRow
        title="Session idle timeout"
        description="Close idle provider sessions after this interval."
        control={
          <select
            aria-label="Session idle timeout"
            className={selectClass}
            disabled={disabled}
            value={agent.sessionIdleMinutes ?? "never"}
            onChange={(event) => {
              const value = Number(event.target.value);
              void writeAgent({
                sessionIdleMinutes: value === 30 || value === 120 || value === 480 ? value : null,
              });
            }}
          >
            <option value="never">Never</option>
            <option value="30">30 minutes</option>
            <option value="120">2 hours</option>
            <option value="480">8 hours</option>
          </select>
        }
      />
      <SettingsRow
        title="Session size budget"
        description="Rotate a session at this percentage of its model context window."
        control={numberInput(
          agent.sessionBudgetPercent,
          10,
          90,
          "Session size budget percent",
          (sessionBudgetPercent) => void writeAgent({ sessionBudgetPercent }),
        )}
      />
      <SettingsRow
        title="Agent thread auto-archive"
        description="Archive completed agent-started threads once reported, or 24 hours later. Replies, pins, pending questions, and linked pull requests prevent archiving."
        control={
          <select
            aria-label="Agent thread auto-archive"
            className={selectClass}
            disabled={disabled}
            value={agent.agentThreadArchiveHours ?? "off"}
            onChange={(event) =>
              void writeAgent({
                agentThreadArchiveHours:
                  event.target.value === "24" ? 24 : event.target.value === "0" ? 0 : null,
              })
            }
          >
            <option value="off">Off</option>
            <option value="0">On success</option>
            <option value="24">24 hours</option>
          </select>
        }
      />
      <SettingsRow
        title="Heartbeat"
        description="Posts a summary when attention changes. Off by default."
        control={
          <select
            aria-label="Agent heartbeat"
            className={selectClass}
            disabled={disabled}
            value={agent.heartbeatMinutes ?? "off"}
            onChange={(event) => {
              const value = Number(event.target.value);
              void writeAgent({
                heartbeatMinutes: value === 15 || value === 30 || value === 60 ? value : null,
              });
            }}
          >
            <option value="off">Off</option>
            {[15, 30, 60].map((value) => (
              <option key={value} value={value}>
                {value} minutes
              </option>
            ))}
          </select>
        }
      />
      <SettingsRow
        title="Quiet hours"
        description="Uses the device UTC offset saved when enabled."
        control={
          <Switch
            aria-label="Agent quiet hours"
            checked={agent.quietHours !== null}
            disabled={disabled}
            onCheckedChange={(enabled) =>
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
        }
      />
      {agent.quietHours
        ? (["startMinute", "endMinute"] as const).map((key) => (
            <SettingsRow
              key={key}
              title={key === "startMinute" ? "Quiet hours start" : "Quiet hours end"}
              control={
                <input
                  aria-label={key === "startMinute" ? "Quiet hours start" : "Quiet hours end"}
                  className={selectClass}
                  type="time"
                  disabled={disabled}
                  value={`${String(Math.floor(agent.quietHours![key] / 60)).padStart(2, "0")}:${String(agent.quietHours![key] % 60).padStart(2, "0")}`}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(":").map(Number);
                    if (
                      agent.quietHours &&
                      hour !== undefined &&
                      minute !== undefined &&
                      Number.isFinite(hour + minute)
                    )
                      void writeAgent({
                        quietHours: { ...agent.quietHours, [key]: hour * 60 + minute },
                      });
                  }}
                />
              }
            />
          ))
        : null}
      <SettingsRow
        title="Stuck threshold"
        description="Minutes without progress before a thread needs attention."
        control={numberInput(
          monitor.stuckAfterMinutes,
          1,
          240,
          "Stuck threshold minutes",
          (stuckAfterMinutes) => void writeMonitor({ stuckAfterMinutes }),
        )}
      />
      {classes.map((kind) => (
        <SettingsRow
          key={kind}
          title={labels[kind]}
          control={
            <Switch
              aria-label={`Notify ${labels[kind]}`}
              checked={monitor.notifyClasses.includes(kind)}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                void writeMonitor({
                  notifyClasses: enabled
                    ? [...monitor.notifyClasses, kind]
                    : monitor.notifyClasses.filter((value) => value !== kind),
                })
              }
            />
          }
        />
      ))}
      <SettingsRow
        title="System probes"
        description="Read host disk usage, failed user services, and server health."
        control={
          <Switch
            aria-label="Agent system probes"
            checked={agent.systemProbeEnabled}
            disabled={disabled}
            onCheckedChange={(enabled) => void writeAgent({ systemProbeEnabled: Boolean(enabled) })}
          />
        }
      />
      <SettingsRow
        title="Disk warning percent"
        control={numberInput(
          agent.diskWarningPercent,
          50,
          99,
          "Disk warning percent",
          (diskWarningPercent) => void writeAgent({ diskWarningPercent }),
        )}
      />
      {state.data?.systemHealth.map((check) => (
        <SettingsRow
          key={check.id}
          title={systemCheckLabel(check)}
          control={
            <span className="text-sm text-muted-foreground">{systemCheckStatus(check)}</span>
          }
        />
      ))}
      <SettingsRow
        title="Local token usage"
        description="Provider-reported counts. Missing counts are unavailable."
        control={
          <span className="text-sm text-muted-foreground">
            {state.data?.usage.length ?? 0} recorded turns
          </span>
        }
      />
      {state.data?.usage
        .slice(-5)
        .toReversed()
        .map((turn) => (
          <p key={turn.runId} className="py-1 text-xs text-muted-foreground">
            {turn.attributes["gen_ai.request.model"]} · input{" "}
            {turn.attributes["gen_ai.usage.input_tokens"] ?? "unavailable"} · output{" "}
            {turn.attributes["gen_ai.usage.output_tokens"] ?? "unavailable"} · cache read{" "}
            {turn.attributes["gen_ai.usage.cache_read.input_tokens"] ?? "unavailable"} · cache write{" "}
            {turn.attributes["gen_ai.usage.cache_creation.input_tokens"] ?? "unavailable"}
          </p>
        ))}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </>
  );
}
