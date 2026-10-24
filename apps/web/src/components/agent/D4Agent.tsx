import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
} from "./d4AgentPresentation";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@d4research/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "@d4research/client-runtime/state/agent-monitor";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

export function D4AgentEntries() {
  const { environments } = useEnvironments();
  return (
    <div className="space-y-1 px-2 pb-2">
      {environments.map((environment) => (
        <D4AgentEntry
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environments.length > 1 ? environment.label : null}
        />
      ))}
    </div>
  );
}
export function D4AgentEntry({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string | null;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useEnvironmentQuery(
    config?.settings.d4Agent.enabled
      ? serverEnvironment.d4AgentState({ environmentId, input: {} })
      : null,
  );
  const ensure = useAtomCommand(serverEnvironment.ensureD4AgentThread);
  const allowed = useAtomValue(serverEnvironment.ensureD4AgentThread.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={
          !config ||
          opening ||
          (config.settings.d4Agent.enabled === true && !state.data?.threadId && !allowed)
        }
        onClick={async () => {
          if (!config) return;
          if (!config.settings.d4Agent.enabled) {
            await navigate({ to: "/settings/general" });
            return;
          }
          if (state.data?.threadId) {
            await navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: state.data.threadId },
            });
            return;
          }
          setOpening(true);
          setError(false);
          await ensure({ environmentId, input: {} })
            .then(async (result) => {
              if (result._tag === "Success")
                await navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: result.value.threadId },
                });
              else setError(true);
            })
            .catch(() => setError(true))
            .finally(() => setOpening(false));
        }}
      >
        {opening ? "Opening d4 Agent…" : `d4 Agent${label ? ` · ${label}` : ""}`}
      </Button>
      {error ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          Could not open d4 Agent. Check that it is enabled with an available model in Settings.
        </p>
      ) : null}
    </>
  );
}
export function D4AgentPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.settings.d4Agent.enabled ? (
    <D4AgentPanelContent environmentId={environmentId} threadId={threadId} />
  ) : null;
}
function D4AgentPanelContent({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(serverEnvironment.d4AgentState({ environmentId, input: {} }));
  const threads = useThreadShells();
  const resolve = useAtomCommand(serverEnvironment.resolveD4AgentAction);
  const allowed = useAtomValue(
    serverEnvironment.resolveD4AgentAction.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const monitorEnabled =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.settings.agentMonitor
      .enabled === true;
  const state = query.data;
  if (!state || state.threadId !== threadId) return null;
  const attention = monitorEnabled
    ? monitorAttentionThreads(
        threads.filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.archivedAt === null &&
            thread.deletedAt === null,
        ),
      )
    : [];
  return (
    <section
      aria-label="d4 Agent attention"
      className="max-h-64 shrink-0 overflow-y-auto border-b bg-muted/20 px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Needs attention · {attention.length}</h2>
        <Button size="sm" variant="ghost" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {!state.modelAvailable ? (
        <p role="status" className="py-1 text-muted-foreground">
          {agentUnavailableMessage(state.unavailableReason)}
        </p>
      ) : null}
      {attention.length === 0 ? (
        <p className="text-muted-foreground">No threads need attention.</p>
      ) : (
        attention.slice(0, AGENT_MONITOR_LIST_LIMIT).map((thread) => (
          <Link
            key={thread.id}
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: thread.id }}
            className="flex justify-between gap-3 rounded px-2 py-1 hover:bg-muted focus-visible:outline focus-visible:outline-ring"
          >
            <span className="truncate">{thread.title}</span>
            <span className="shrink-0 text-muted-foreground">
              {agentMonitorLabel(thread.source.agentMonitor!)}
            </span>
          </Link>
        ))
      )}
      {state.systemHealth.map((check) => (
        <p key={check.id} className="py-1 text-muted-foreground">
          {systemCheckLabel(check)}: {systemCheckStatus(check)}
        </p>
      ))}
      {state.pendingActions.slice(0, 20).map((record) => (
        <div key={record.id} className="flex flex-wrap items-center gap-2 py-1">
          <div className="min-w-0 flex-1">
            <p>
              Approve {record.action.type}
              {"threadId" in record.action
                ? ` · ${record.action.threadId}`
                : ` · ${record.action.projectId}`}
              ?
            </p>
            {"text" in record.action ? (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {record.action.text}
              </p>
            ) : null}
            {record.action.type === "answer" ? (
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(record.action.answers, null, 2)}
              </pre>
            ) : null}
          </div>
          {(["approve", "deny"] as const).map((decision) => (
            <Button
              key={decision}
              size="sm"
              variant={decision === "deny" ? "ghost" : "outline"}
              disabled={!allowed || busy !== null}
              onClick={async () => {
                setBusy(record.id);
                setActionError(null);
                await resolve({ environmentId, input: { actionId: record.id, decision } })
                  .then((result) => {
                    if (result._tag === "Failure") setActionError("Could not resolve this action.");
                    query.refresh();
                  })
                  .catch(() => setActionError("Could not resolve this action."))
                  .finally(() => setBusy(null));
              }}
            >
              {decision === "approve" ? "Approve" : "Deny"}
            </Button>
          ))}
        </div>
      ))}
      {state.actionLog.length > 0 ? (
        <details className="pt-2">
          <summary className="cursor-pointer">Action log · {state.actionLog.length}</summary>
          {state.actionLog
            .slice(-20)
            .toReversed()
            .map((record) => (
              <p key={record.id} className="py-1 text-xs text-muted-foreground">
                {record.createdAt} · {record.action.type} · {record.status}
              </p>
            ))}
        </details>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {query.error ? <p role="alert">{query.error}</p> : null}
    </section>
  );
}
