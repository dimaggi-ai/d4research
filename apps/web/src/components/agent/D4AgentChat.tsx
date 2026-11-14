import { ChatViewComposerSlot } from "../chat/ChatViewComposerSlot";
import { appendNiaSystemNotices } from "@d4research/client-runtime/d4-agent-timeline";
import { type D4AgentState, type EnvironmentId, type ThreadId } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState, type ReactNode } from "react";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import ChatView, { type ChatViewComposerHandle } from "../ChatView";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";
import { agentActivityLabel, agentWatchLabel, niaPresence } from "./d4AgentPresentation";
import { NiaAvatar } from "./NiaAvatar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { ChatWorkspaceHeader } from "../chat/ChatWorkspaceHeader";
import { NiaRoutines } from "./NiaRoutines";
import { D4AgentComposer } from "./D4AgentComposer";

export function D4AgentRoute({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  children: ReactNode;
}) {
  const identity = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.d4AgentIdentity({ environmentId, input: {} }),
  );
  // A request interrupted by a server restart never settles on its own; refetch until it answers.
  useLiveRefresh(identity.refresh, {
    enabled: environmentId !== null && identity.data === null,
    key: `d4-agent-identity:${environmentId}`,
    intervalMs: 5_000,
  });
  const shell = useThreadShell(
    environmentId !== null && threadId !== null ? { environmentId, threadId } : null,
  );
  const isAgentProject =
    environmentId !== null &&
    threadId !== null &&
    identity.data !== null &&
    (identity.data.threadId === threadId || shell?.projectId === identity.data.projectId);
  const resolveArchivedRoute = environmentId !== null && threadId !== null && shell === null;
  const query = useD4AgentState(environmentId, isAgentProject || resolveArchivedRoute);
  const state = query.data;
  const isAgentRoute =
    isAgentProject || (threadId !== null && state?.chatThreadIds?.includes(threadId) === true);
  // Ordinary chats never wait on Nia's identity: when that request did not settle, every route
  // stayed on this placeholder.
  if ((isAgentProject && !state) || (resolveArchivedRoute && !state && query.error === null))
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading Nia…
      </p>
    );
  return isAgentRoute && state && environmentId !== null ? (
    <D4AgentChat
      environmentId={environmentId}
      state={state}
      refresh={query.refresh}
      threadId={threadId}
    />
  ) : (
    children
  );
}

export function D4AgentChat({
  environmentId,
  threadId,
  state,
  refresh,
}: {
  environmentId: EnvironmentId;
  threadId?: ThreadId | null;
  state: D4AgentState;
  refresh: () => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [selection, setSelection] = useState({
    routeId: threadId,
    activeId: state.threadId,
    context: state.brainContext,
    visibleId: threadId ?? state.threadId,
  });
  let conversationThreadId = selection.visibleId;
  if (selection.routeId !== threadId) {
    conversationThreadId = threadId ?? state.threadId;
  } else if (
    state.threadId !== null &&
    (selection.context !== state.brainContext ||
      (selection.activeId !== state.threadId && selection.visibleId === selection.activeId))
  ) {
    conversationThreadId = state.threadId;
  }
  if (
    selection.routeId !== threadId ||
    selection.activeId !== state.threadId ||
    selection.context !== state.brainContext
  ) {
    setSelection({
      routeId: threadId,
      activeId: state.threadId,
      context: state.brainContext,
      visibleId: conversationThreadId,
    });
  }
  const composerHandle = useRef<ChatViewComposerHandle>(null);
  const conversationContext =
    conversationThreadId === state.threadId
      ? state.brainContext
      : state.openSessions?.find((session) => session.threadId === conversationThreadId)?.context;
  const agentShell = useThreadShell(
    state.threadId ? { environmentId, threadId: state.threadId } : null,
  );
  const activity = agentActivityLabel({
    runtime: agentShell?.runtime ?? null,
    latestRun: agentShell?.latestRun ?? null,
    formatTime: (iso) =>
      new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  });
  const watch = agentWatchLabel({
    heartbeatMinutes: config?.settings.d4Agent.heartbeatMinutes ?? null,
    monitorEnabled: config?.settings.agentMonitor.enabled === true,
  });
  return (
    <D4AgentPanel
      environmentId={environmentId}
      threadId={state.threadId}
      render={({ approvals, details }) => {
        const header = (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <WorkspaceBreadcrumb ariaLabel="Active thread">
              <WorkspaceBreadcrumbItem current>
                <span className="mr-2">
                  <NiaAvatar presence={niaPresence(activity, watch)} />
                </span>
                <WorkspaceBreadcrumbText>Nia</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <NiaRoutines environmentId={environmentId} state={state} />
          </div>
        );
        const composer = (
          <>
            {details}
            <D4AgentComposer
              key={environmentId}
              ref={composerHandle}
              environmentId={environmentId}
              state={state}
              active={activity.tone === "working"}
              refresh={refresh}
              banner={approvals}
              onSent={(visibleId) => setSelection((current) => ({ ...current, visibleId }))}
            />
          </>
        );
        return (
          <ChatViewComposerSlot composer={composer}>
            {(composerSlot) => (
              <section
                aria-label="Nia chat"
                className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden bg-background"
              >
                {conversationThreadId ? (
                  <ChatView
                    environmentId={environmentId}
                    threadId={conversationThreadId}
                    routeKind="server"
                    header={header}
                    composer={composerSlot}
                    composerHandle={composerHandle}
                    mapTimelineItems={(items) =>
                      conversationContext === undefined
                        ? items
                        : appendNiaSystemNotices(
                            items,
                            state.transcript ?? [],
                            environmentId,
                            conversationThreadId,
                            conversationContext,
                          )
                    }
                  />
                ) : (
                  <>
                    <ChatWorkspaceHeader>{header}</ChatWorkspaceHeader>
                    <div className="mt-auto chat-composer-lane">{composerSlot}</div>
                  </>
                )}
              </section>
            )}
          </ChatViewComposerSlot>
        );
      }}
    />
  );
}
