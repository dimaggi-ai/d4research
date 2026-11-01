import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type D4AgentState,
  type EnvironmentId,
  type ModelSelection,
  type ScheduledTask,
} from "@d4research/contracts";
import { createModelSelection } from "@d4research/shared/model";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useMergedSettings } from "../../hooks/useSettings";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { RightPanelSheet } from "../RightPanelSheet";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { d4AgentTaskFailureMessage } from "./d4AgentTaskFeedback";
import { routineScheduleLabel, routineInContext } from "./niaRoutines.logic";

export function NiaRoutines({
  environmentId,
  state,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div>
        <Button variant="ghost" size="sm" aria-label="Open routines" onClick={() => setOpen(true)}>
          <CalendarClockIcon className="size-4" /> Routines
        </Button>
      </div>
      <RightPanelSheet
        animationDurationMs={180}
        open={open}
        onClose={() => setOpen(false)}
        showCloseButton
      >
        <SheetHeader>
          <SheetTitle>Routines</SheetTitle>
          <SheetDescription>Scheduled jobs and preparation progress.</SheetDescription>
        </SheetHeader>
        {open ? (
          <NiaRoutinesContent
            key={`${environmentId}:${state.brainContext}`}
            environmentId={environmentId}
            state={state}
          />
        ) : null}
      </RightPanelSheet>
    </>
  );
}

function NiaRoutinesContent({
  environmentId,
  state,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useMergedSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS)!;
  const configuredTaskModel = settings.d4Agent.taskModelSelection;
  const [taskModelOverride, setTaskModelOverride] = useState<ModelSelection | null>(null);
  const taskModel = taskModelOverride ?? configuredTaskModel;
  const taskPickerModel = taskModel ?? resolveAppModelSelectionState(settings, providers);
  const taskEntries = providerInstanceEntriesFor(providers, settings, null);
  const taskModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    taskPickerModel.instanceId,
    taskPickerModel.model,
  );
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const tasks = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const canSend = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const visible = tasks.data?.tasks.filter((task) =>
    routineInContext(
      task.projectId,
      state.brainContext,
      config?.settings.d4Agent.projectContexts ?? {},
    ),
  );
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || !brief.trim() || !canSend || !connected || state.threadId === null)
            return;
          lock.current = true;
          setBusy(true);
          setError(null);
          setSent(false);
          try {
            const result = await send({
              environmentId,
              input: {
                text: `Prepare a new routine from this brief. Use prepare-routine to open a new visible setup thread, prepare prerequisites with bounded coding agents, and keep activation separate for review. Brief:\n${brief.trim()}`,
                ...(taskModel === null ? {} : { taskModelSelection: taskModel }),
                expectedContext: state.brainContext,
                expectedThreadId: state.threadId,
                followUpBehavior: "queue",
              },
            });
            if (result._tag === "Failure")
              setError(
                d4AgentTaskFailureMessage({
                  failure: squashAtomCommandFailure(result),
                  preserved: "Your brief is preserved.",
                  providers,
                  selection: taskModel,
                }),
              );
            else {
              setBrief("");
              setTaskModelOverride(null);
              setSent(true);
            }
          } catch {
            setError("Could not send this message. Your brief is preserved.");
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <SettingsSection title="New job">
          <SettingsRow
            title="Worker"
            control={
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={taskPickerModel.instanceId}
                model={taskPickerModel.model}
                lockedProvider={null}
                instanceEntries={taskEntries}
                modelOptionsByInstance={taskModelOptions}
                triggerAriaLabel="Routine worker model"
                {...(taskModel ? {} : { triggerLabel: "Choose model" })}
                disabled={busy}
                onInstanceModelChange={(instanceId, model) =>
                  setTaskModelOverride(createModelSelection(instanceId, model))
                }
              />
            }
          />
          <SettingsRow
            title={<label htmlFor="nia-routine-brief">New job</label>}
            description="Nia proposes the selected worker for approval. Scheduling starts after preparation finishes and you approve activation."
          >
            <textarea
              id="nia-routine-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              maxLength={12000}
              className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm"
              placeholder="What should run, and when?"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={
                  !canSend ||
                  !connected ||
                  busy ||
                  !brief.trim() ||
                  state.threadId === null ||
                  taskModel === null
                }
              >
                {busy ? "Sending…" : "Prepare job"}
              </Button>
              {sent ? <p role="status">Request sent. Review Nia’s proposal in the chat.</p> : null}
            </div>
            {error ? (
              <p role="alert" className="mt-2 text-destructive">
                {error}
              </p>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      </form>
      <SettingsSection title="Routines" hideTitle>
        {(state.routines ?? [])
          .filter((routine) => routine.context === state.brainContext)
          .map((routine) => (
            <SettingsRow
              key={routine.id}
              title={routine.draft.title}
              description={`Preparation: ${routine.status}`}
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: routine.threadId }}
                    />
                  }
                >
                  Open preparation
                </Button>
              }
            >
              <details>
                <summary className="cursor-pointer">Proposed job</summary>
                <p>{routineScheduleLabel(routine.draft.schedule)}</p>
                <p>
                  {routine.draft.modelSelection.instanceId} / {routine.draft.modelSelection.model}
                </p>
                {routine.draft.pipelineId ? <p>{routine.draft.pipelineId}</p> : null}
                <p className="whitespace-pre-wrap break-words">{routine.draft.text}</p>
              </details>
              {routine.readiness ? <p>{routine.readiness.summary}</p> : null}
            </SettingsRow>
          ))}
        {!connected ? (
          <SettingsRow title="Connect to view routines." role="status" />
        ) : tasks.error ? (
          <SettingsRow
            title="Routines are unavailable."
            role="alert"
            control={
              <Button size="sm" variant="ghost" onClick={tasks.refresh}>
                Retry
              </Button>
            }
          />
        ) : visible === undefined ? (
          <SettingsRow title="Loading routines…" role="status" />
        ) : visible.length === 0 ? (
          <SettingsRow title="No scheduled jobs in this context." />
        ) : (
          visible.map((task) => (
            <RoutineRow
              key={task.id}
              task={task}
              environmentId={environmentId}
              connected={connected}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Host routines">
        <SettingsRow
          title="Host routines"
          description="Read-only snapshots from local configuration. System timers and cron jobs are managed by the host."
        />
        {connected && state.hostRoutines?.status === "available" ? (
          state.hostRoutines.routines.map((routine) => (
            <SettingsRow
              key={routine.id}
              title={routine.title}
              description={`${routine.source} · Read-only`}
            >
              <p>
                {routine.enabled === null
                  ? "State unknown"
                  : routine.enabled
                    ? "Enabled"
                    : "Disabled"}{" "}
                · {routine.schedule} · {routine.timeZone}
              </p>
              <p>
                Next at snapshot:{" "}
                {routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : "Unknown"}
              </p>
              <p>
                Latest: {routine.lastRunStatus}
                {routine.lastRunAt ? ` · ${new Date(routine.lastRunAt).toLocaleString()}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Observed: {new Date(routine.observedAt).toLocaleString()}
              </p>
            </SettingsRow>
          ))
        ) : (
          <SettingsRow
            title={
              state.hostRoutines?.status === "unavailable"
                ? "Host inventory could not be read."
                : "No host inventory available."
            }
          />
        )}
      </SettingsSection>
    </div>
  );
}

function RoutineRow({
  task,
  environmentId,
  connected,
}: {
  task: ScheduledTask;
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const allowed = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState(false);
  return (
    <SettingsRow
      title={task.title}
      description={`${task.enabled ? "Enabled" : "Disabled"} · ${routineScheduleLabel(task.schedule)}`}
    >
      <p>Next: {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "No next run"}</p>
      <p>
        Latest: {task.lastRunStatus}
        {task.lastRunAt ? ` · ${new Date(task.lastRunAt).toLocaleString()}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!allowed || !connected || busy}
          onClick={async () => {
            if (lock.current || !allowed || !connected) return;
            lock.current = true;
            setBusy(true);
            setError(false);
            try {
              const result = await toggle({
                environmentId,
                input: { id: task.id, enabled: !task.enabled },
              });
              if (result._tag === "Failure") setError(true);
            } catch {
              setError(true);
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : task.enabled ? "Disable" : "Enable"}
        </Button>
        {task.lastRunThreadId ? (
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: task.lastRunThreadId }}
              />
            }
          >
            Latest run
          </Button>
        ) : null}
      </div>
      {!allowed ? <p className="text-xs text-muted-foreground">Read-only access</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          Could not update this job.
        </p>
      ) : null}
    </SettingsRow>
  );
}
