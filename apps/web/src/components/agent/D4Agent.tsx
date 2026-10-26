import * as Effect from "effect/Effect";
import { waitForD4AgentThreadShell } from "@d4research/client-runtime/state/server";
import { environmentThreadShells } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useD4AgentState } from "./useD4AgentState";
import {
  agentUnavailableMessage,
  actionHeading,
  guardNotice,
  agentActivityLabel,
  agentWatchLabel,
  niaPresence,
} from "./d4AgentPresentation";
import { NiaAvatar } from "./NiaAvatar";
import { useAtomValue } from "@effect/atom-react";
import {
  D4_BRAIN_CONTEXTS,
  type D4AgentActionSummary,
  type EnvironmentId,
  type ThreadId,
} from "@d4research/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
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
  const environment = useEnvironment(environmentId);
  const state = useD4AgentState(environmentId, config?.settings.d4Agent.enabled === true);
  const ensure = useAtomCommand(serverEnvironment.ensureD4AgentThread);
  const allowed = useAtomValue(serverEnvironment.ensureD4AgentThread.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  const agentShell = useThreadShell(
    state.data?.threadId ? { environmentId, threadId: state.data.threadId } : null,
  );
  const presence = config?.settings.d4Agent.enabled
    ? niaPresence(
        agentActivityLabel({
          runtime: agentShell?.runtime ?? null,
          latestRun: agentShell?.latestRun ?? null,
          formatTime: () => "",
        }),
        agentWatchLabel({
          heartbeatMinutes: config.settings.d4Agent.heartbeatMinutes,
          monitorEnabled: config.settings.agentMonitor.enabled,
        }),
      )
    : undefined;
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        disabled={
          !config ||
          opening ||
          (config.settings.d4Agent.enabled === true &&
            (allowed ? environment?.connection.phase !== "connected" : !state.data?.threadId))
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
        <NiaAvatar presence={presence} className="size-5" />
        {`Nia${label ? ` · ${label}` : ""}`}
      </Button>
      {error ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          Could not open Nia. Check that it is enabled with an available model in Settings.
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
  const resolve = useAtomCommand(serverEnvironment.resolveD4AgentAction);
  const allowed = useAtomValue(
    serverEnvironment.resolveD4AgentAction.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = query.data;
  if (!state || state.threadId !== threadId) return null;
  const proposals = (state.memoryProposals ?? []).filter(
    (proposal) => proposal.context === state.brainContext,
  );
  const shownPendingProposals = proposals.filter(
    (proposal) => proposal.status === "pending",
  ).length;
  const pendingProposals = Math.max(state.memoryProposalCount ?? 0, shownPendingProposals);
  const pendingActions = state.actionLog.filter((record) => record.status === "pending").length;
  return (
    <div className="shrink-0 border-b text-sm">
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5">
        <label className="sr-only" htmlFor="d4-agent-context">
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
        {(state.reminders ?? []).length > 0 ? (
          <details className="relative">
            <summary className="cursor-pointer text-muted-foreground">
              Reminders · {state.reminders?.length}
            </summary>
            <ul className="absolute z-10 mt-1 max-h-[60dvh] w-[min(24rem,90vw)] space-y-1 overflow-y-auto rounded-md border bg-popover p-2 shadow-md">
              {state.reminders?.map((reminder) => (
                <li key={reminder.id}>
                  <span className="text-muted-foreground">
                    {new Date(reminder.at).toLocaleString()}
                  </span>{" "}
                  {reminder.text}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {state.actionLog.some((record) => record.status !== "pending") ? (
          <details className="relative">
            <summary className="cursor-pointer text-muted-foreground">History</summary>
            <div className="absolute z-10 mt-1 max-h-[60dvh] w-[min(32rem,90vw)] overflow-y-auto rounded-md border bg-popover p-2 shadow-md">
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
            </div>
          </details>
        ) : null}
      </div>
      <section
        aria-label="Waiting for you"
        className={
          pendingActions + pendingProposals > 0 ||
          proposals.some((proposal) => proposal.status !== "rejected") ||
          !state.modelAvailable ||
          actionError ||
          query.error
            ? "max-h-[40dvh] overflow-y-auto px-4 pb-3 md:max-h-64"
            : "hidden"
        }
      >
        {!state.modelAvailable ? (
          <p role="status" className="py-1 text-muted-foreground">
            {agentUnavailableMessage(state.unavailableReason)}
          </p>
        ) : null}
        {proposals.some((proposal) => proposal.status !== "rejected") ? (
          <section aria-label="Memory proposals" className="space-y-2 py-2">
            <h2 className="font-medium">Memory proposals · {pendingProposals} pending</h2>
            {pendingProposals > shownPendingProposals ? (
              <p className="text-xs text-muted-foreground">
                Showing the oldest {shownPendingProposals}. Review them to see the rest.
              </p>
            ) : null}
            {proposals
              .filter((proposal) => proposal.status !== "rejected")
              .map((proposal) => (
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
                await resolve({
                  environmentId,
                  input: { actionId: record.id, decision, ...options },
                })
                  .then((result) => {
                    if (result._tag === "Failure") setActionError("Could not resolve this action.");
                    query.refresh();
                  })
                  .catch(() => setActionError("Could not resolve this action."))
                  .finally(() => setBusy(null));
              }}
            />
          ))}
        {actionError ? <p role="alert">{actionError}</p> : null}
        {query.error ? <p role="alert">{query.error}</p> : null}
      </section>
    </div>
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
  // A pending switch shows its replay up front so the user sees what will be resent.
  const pendingSwitch = record.type === "switch-context" && record.status === "pending";
  const detail = useEnvironmentQuery(
    reviewing || pendingSwitch
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
  const switchAction = detail.data?.action.type === "switch-context" ? detail.data.action : null;
  const heading = actionHeading(record);
  const guard = guardNotice(record.guard);
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
      <p>{heading.title}</p>
      {heading.detail ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{heading.detail}</p>
      ) : null}
      {guard ? <p className="text-xs text-muted-foreground">{guard.title}</p> : null}
      {pendingSwitch ? null : (
        <Button size="sm" variant="ghost" onClick={() => setReviewing(!reviewing)}>
          {reviewing ? "Hide action details" : "Review action"}
        </Button>
      )}
      {reviewing && detail.data && !sendAction && !launchAction && !switchAction ? (
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
      {(reviewing || pendingSwitch) && switchAction ? (
        <div className="space-y-2 rounded border p-3">
          <p className="text-xs text-muted-foreground">
            {switchAction.originalText
              ? `Request to resend in ${switchAction.targetContext ?? "the new context"}`
              : "No request will be resent."}
          </p>
          {switchAction.originalText ? (
            <p className="whitespace-pre-wrap break-words">{switchAction.originalText}</p>
          ) : null}
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
            {sendAction ? "Send" : record.type === "switch-context" ? "Switch" : "Approve"}
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
