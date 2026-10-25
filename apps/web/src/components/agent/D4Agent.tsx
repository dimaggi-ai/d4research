import { D4AgentSessions } from "./D4AgentSessions";
import * as Effect from "effect/Effect";
import { waitForD4AgentThreadShell } from "@d4research/client-runtime/state/server";
import { environmentThreadShells } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useD4AgentState } from "./useD4AgentState";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  projectBelongsToAgentContext,
} from "./d4AgentPresentation";
import { useAtomValue } from "@effect/atom-react";
import {
  D4_BRAIN_CONTEXTS,
  type D4AgentActionSummary,
  type EnvironmentId,
  type ThreadId,
} from "@d4research/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
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
import { useSidebarVisibility } from "../ui/sidebar";

function waitForAgentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  return Effect.runPromise(
    waitForD4AgentThreadShell(
      appAtomRegistry,
      environmentThreadShells.threadShellAtom({ environmentId, threadId }),
    ),
  );
}

export function D4AgentEntries({ children }: { children?: ReactNode }) {
  const { environments } = useEnvironments();
  const visible = useSidebarVisibility();
  if (!visible) return children;
  return (
    <>
      <div className="space-y-1 px-2 pb-2">
        {environments.map((environment) => (
          <D4AgentEntry
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environments.length > 1 ? environment.label : null}
          />
        ))}
      </div>
      {children}
    </>
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
  const state = useD4AgentState(environmentId, config?.settings.d4Agent.enabled === true);
  const ensure = useAtomCommand(serverEnvironment.ensureD4AgentThread);
  const allowed = useAtomValue(serverEnvironment.ensureD4AgentThread.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 p-1">
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
          if (state.data?.threadId && !allowed) {
            if (!(await waitForAgentThread(environmentId, state.data.threadId))) {
              setError(true);
              return;
            }
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
              if (
                result._tag === "Success" &&
                (await waitForAgentThread(environmentId, result.value.threadId))
              )
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
    </div>
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
  const identity = useEnvironmentQuery(
    config?.settings.d4Agent.enabled
      ? serverEnvironment.d4AgentIdentity({ environmentId, input: {} })
      : null,
  );
  return config?.settings.d4Agent.enabled && identity.data?.threadId === threadId ? (
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
  const query = useD4AgentState(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const switchContext = useAtomCommand(serverEnvironment.switchD4AgentContext);
  const newSession = useAtomCommand(serverEnvironment.newD4AgentSession);
  const canStartSession = useAtomValue(
    serverEnvironment.newD4AgentSession.permissionAtom(environmentId),
  );
  const resolveProposal = useAtomCommand(serverEnvironment.resolveD4AgentMemoryProposal);
  const canResolveProposal = useAtomValue(
    serverEnvironment.resolveD4AgentMemoryProposal.permissionAtom(environmentId),
  );
  const [startingSession, setStartingSession] = useState(false);
  const canSwitch = useAtomValue(
    serverEnvironment.switchD4AgentContext.permissionAtom(environmentId),
  );
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const threads = useThreadShells();
  const resolve = useAtomCommand(serverEnvironment.resolveD4AgentAction);
  const allowed = useAtomValue(
    serverEnvironment.resolveD4AgentAction.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const monitorEnabled = config?.settings.agentMonitor.enabled === true;
  const state = query.data;
  if (!state || state.threadId !== threadId) return null;
  const proposals = (state.memoryProposals ?? []).filter(
    (proposal) => proposal.context === state.brainContext,
  );
  const attention = monitorEnabled
    ? monitorAttentionThreads(
        threads.filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.archivedAt === null &&
            thread.deletedAt === null &&
            projectBelongsToAgentContext(
              thread.projectId,
              state.brainContext,
              config?.settings.d4Agent.projectContexts ?? {},
            ),
        ),
      )
    : [];
  return (
    <section
      aria-label="d4 Agent attention"
      className="max-h-64 shrink-0 overflow-y-auto border-b bg-muted/20 px-4 py-3 text-sm"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="text-muted-foreground" htmlFor="d4-agent-context">
          Context
        </label>
        <select
          id="d4-agent-context"
          aria-label="Agent context"
          className="rounded-full border border-input bg-background px-3 py-1 text-sm focus-visible:outline focus-visible:outline-ring"
          value={state.brainContext}
          disabled={!canSwitch || switching || startingSession}
          onChange={async (event) => {
            const context = D4_BRAIN_CONTEXTS.find((value) => value === event.target.value);
            if (!context || context === state.brainContext) return;
            setSwitching(true);
            setActionError(null);
            await switchContext({ environmentId, input: { context } })
              .then(async (result) => {
                if (
                  result._tag === "Failure" ||
                  !(await waitForAgentThread(environmentId, result.value.threadId))
                )
                  setActionError("Could not switch context.");
                else
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: result.value.threadId },
                  });
              })
              .catch(() => setActionError("Could not switch context."))
              .finally(() => setSwitching(false));
          }}
        >
          {D4_BRAIN_CONTEXTS.map((context) => (
            <option key={context} value={context}>
              {context}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!canStartSession || switching || startingSession}
          onClick={async () => {
            setStartingSession(true);
            setActionError(null);
            await newSession({ environmentId, input: {} })
              .then(async (result) => {
                if (
                  result._tag === "Failure" ||
                  !(await waitForAgentThread(environmentId, result.value.threadId))
                )
                  setActionError("Could not start a new session.");
                else
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: result.value.threadId },
                  });
              })
              .catch(() => setActionError("Could not start a new session."))
              .finally(() => setStartingSession(false));
          }}
        >
          {startingSession ? "Starting session…" : "New session"}
        </Button>
        {switching ? <span role="status">Switching context…</span> : null}
      </div>
      <D4AgentSessions
        environmentId={environmentId}
        sessions={state.openSessions ?? []}
        refresh={query.refresh}
      />
      {state.sessionChangeReason ? (
        <p role="status" className="mb-2 border-b pb-2 text-xs text-muted-foreground">
          {state.sessionChangeReason === "resumed"
            ? `Resumed ${state.brainContext} session.`
            : state.sessionChangeReason === "size"
              ? "Session size budget reached. New session."
              : state.sessionChangeReason === "new-session"
                ? "New session."
                : `Context changed to ${state.brainContext}. New session.`}
        </p>
      ) : null}
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
      {state.ctoAskInFlight ? <p role="status">CTO question in progress.</p> : null}
      {proposals.length > 0 ? (
        <section aria-label="Memory proposals" className="space-y-2 py-2">
          <h2 className="font-medium">Memory proposals · {proposals.length}</h2>
          {proposals.map((proposal) => (
            <div key={proposal.id} className="space-y-2 rounded border p-2">
              <p className="text-xs text-muted-foreground">
                {proposal.context} ·{" "}
                {proposal.createdAt === null ? (
                  "Creation time unavailable"
                ) : (
                  <time dateTime={proposal.createdAt}>{proposal.createdAt}</time>
                )}{" "}
                · {proposal.status}
              </p>
              <p className="whitespace-pre-wrap break-words select-text">{proposal.text}</p>
              {proposal.status === "pending" ? (
                <div className="flex gap-2">
                  {[true, false].map((approve) => (
                    <Button
                      key={String(approve)}
                      size="sm"
                      variant={approve ? "outline" : "ghost"}
                      disabled={!canResolveProposal || busy !== null}
                      onClick={async () => {
                        setBusy(proposal.id);
                        setActionError(null);
                        await resolveProposal({
                          environmentId,
                          input: { proposalId: proposal.id, approve },
                        })
                          .then((result) => {
                            if (result._tag === "Failure")
                              setActionError("Could not review this memory proposal.");
                            query.refresh();
                          })
                          .catch(() => setActionError("Could not review this memory proposal."))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {approve ? "Approve" : "Reject"}
                    </Button>
                  ))}
                </div>
              ) : proposal.status === "approved" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(proposal.text);
                    } catch {
                      setActionError(
                        "Could not copy this memory proposal. Select the text to copy it.",
                      );
                    }
                  }}
                >
                  Copy text
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {(state.otherContextProposalCounts ?? []).map(({ context, count }) => (
        <p key={context} className="text-xs text-muted-foreground">
          Pending memory proposals · {context}: {count}
        </p>
      ))}
      {state.actionLog
        .filter((record) => record.status === "pending")
        .map((record) => (
          <AgentActionRecord
            key={record.id}
            environmentId={environmentId}
            record={record}
            allowed={allowed}
            busy={busy !== null}
            onResolve={async (decision, options) => {
              setBusy(record.id);
              setActionError(null);
              await resolve({ environmentId, input: { actionId: record.id, decision, ...options } })
                .then((result) => {
                  if (result._tag === "Failure") setActionError("Could not resolve this action.");
                  query.refresh();
                })
                .catch(() => setActionError("Could not resolve this action."))
                .finally(() => setBusy(null));
            }}
          />
        ))}
      {state.actionLog.length > 0 ? (
        <details className="pt-2">
          <summary className="cursor-pointer">Action log · {state.actionLog.length}</summary>
          {state.actionLog
            .filter((record) => record.status !== "pending")
            .slice(0, 20)
            .map((record) => (
              <AgentActionRecord
                key={record.id}
                environmentId={environmentId}
                record={record}
                allowed={allowed}
                busy={busy !== null}
                onResolve={async () => undefined}
              />
            ))}
        </details>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {query.error ? <p role="alert">{query.error}</p> : null}
    </section>
  );
}

function AgentActionRecord({
  environmentId,
  record,
  allowed,
  busy,
  onResolve,
}: {
  environmentId: EnvironmentId;
  record: D4AgentActionSummary;
  allowed: boolean;
  busy: boolean;
  onResolve: (
    decision: "approve" | "deny",
    options?: { editedText?: string; sendOriginal?: boolean },
  ) => Promise<void>;
}) {
  const undoArchive = useAtomCommand(serverEnvironment.undoD4AgentArchive);
  const canUndoArchive = useAtomValue(
    serverEnvironment.undoD4AgentArchive.permissionAtom(environmentId),
  );
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState<string | null>(null);
  const detail = useEnvironmentQuery(
    reviewing
      ? serverEnvironment.d4AgentAction({ environmentId, input: { actionId: record.id } })
      : null,
  );
  const refreshDetail = useEffectEvent(detail.refresh);
  const previousResolution = useRef({ status: record.status, resolvedAt: record.resolvedAt });
  useEffect(() => {
    if (
      reviewing &&
      (previousResolution.current.status !== record.status ||
        previousResolution.current.resolvedAt !== record.resolvedAt)
    )
      refreshDetail();
    previousResolution.current = { status: record.status, resolvedAt: record.resolvedAt };
  }, [record.status, record.resolvedAt, reviewing]);
  const canApprove =
    allowed && !busy && detail.data?.id === record.id && detail.data.status === "pending";
  const sendAction = detail.data?.action.type === "send" ? detail.data.action : null;
  const finalText = editedText ?? sendAction?.text ?? "";
  const launchAction =
    detail.data &&
    (detail.data.action.type === "research" ||
      detail.data.action.type === "pipeline" ||
      detail.data.action.type === "start")
      ? detail.data.action
      : null;
  return (
    <div className="space-y-2 py-2">
      <p>
        {record.type} · {record.targetId}
      </p>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{record.preview}</p>
      <Button size="sm" variant="ghost" onClick={() => setReviewing(!reviewing)}>
        {reviewing ? "Hide action details" : "Review action"}
      </Button>
      {reviewing && detail.data && !sendAction && !launchAction ? (
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(
            {
              context: detail.data.context,
              action: detail.data.action,
              ...(typeof detail.data.result === "string" ? {} : { result: detail.data.result }),
            },
            null,
            2,
          )}
        </pre>
      ) : null}
      {reviewing && typeof detail.data?.result === "string" ? (
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
          {detail.data.result}
        </pre>
      ) : null}
      {reviewing && launchAction ? (
        <div className="space-y-2 rounded border p-3">
          <p className="text-xs text-muted-foreground">Target project · {launchAction.projectId}</p>
          {launchAction.type !== "start" ? (
            <p className="text-xs text-muted-foreground">Pipeline · {launchAction.pipelineId}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Model · {launchAction.modelSelection.instanceId} / {launchAction.modelSelection.model}
          </p>
          <p className="text-xs text-muted-foreground">Final prompt</p>
          <p className="whitespace-pre-wrap break-words">{launchAction.text}</p>
        </div>
      ) : null}
      {reviewing && sendAction ? (
        <div className="space-y-2 rounded border p-3">
          {sendAction.originalText !== undefined ? (
            <>
              <p className="text-xs text-muted-foreground">Original</p>
              <p className="whitespace-pre-wrap break-words">{sendAction.originalText}</p>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">Rewritten prompt</p>
          {editing ? (
            <textarea
              aria-label="Edit rewritten prompt"
              value={finalText}
              onChange={(event) => setEditedText(event.target.value)}
              className="min-h-24 w-full rounded border border-input bg-background p-2 focus-visible:outline focus-visible:outline-ring"
            />
          ) : (
            <p className="whitespace-pre-wrap break-words">{finalText}</p>
          )}
          {record.status === "pending" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!canApprove}
              onClick={() => setEditing(!editing)}
            >
              {editing ? "Done editing" : "Edit"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {detail.error ? <p role="alert">{detail.error}</p> : null}
      {record.type === "auto-archive" && record.status === "executed" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canUndoArchive || undoing}
          onClick={async () => {
            setUndoing(true);
            setUndoError(false);
            try {
              const result = await undoArchive({ environmentId, input: { actionId: record.id } });
              if (result._tag === "Failure") setUndoError(true);
              else refreshDetail();
            } catch {
              setUndoError(true);
            }
            setUndoing(false);
          }}
        >
          {undoing ? "Restoring…" : "Undo archive"}
        </Button>
      ) : null}
      {undoError ? <p role="alert">Could not restore this thread.</p> : null}
      {record.status === "pending" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canApprove || (sendAction !== null && !finalText.trim())}
            onClick={() =>
              void onResolve(
                "approve",
                sendAction && editedText !== null ? { editedText } : undefined,
              )
            }
          >
            {sendAction ? "Send" : "Approve"}
          </Button>
          {sendAction?.originalText ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canApprove}
              onClick={() => void onResolve("approve", { sendOriginal: true })}
            >
              Send original
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!allowed || busy}
            onClick={() => void onResolve("deny")}
          >
            Deny
          </Button>
        </div>
      ) : null}
    </div>
  );
}
