import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { type D4AgentState, type EnvironmentId, type ThreadId } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "@d4research/shared/markdownPipeline";
import {
  niaSystemTextSegments,
  type NiaTextSegment,
} from "@d4research/client-runtime/d4-agent-references";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";
import { agentActivityLabel, agentWatchLabel, niaPresence } from "./d4AgentPresentation";
import { NiaAvatar } from "./NiaAvatar";

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
  if (
    (environmentId !== null && identity.isPending && identity.data === null) ||
    (isAgentProject && !state) ||
    (resolveArchivedRoute && !state && query.error === null)
  )
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading Nia…
      </p>
    );
  return isAgentRoute && state && environmentId !== null ? (
    <D4AgentChat environmentId={environmentId} state={state} refresh={query.refresh} />
  ) : (
    children
  );
}

export function D4AgentChat({
  environmentId,
  state,
  refresh,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
  refresh: () => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
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
  const conversation = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  useEffect(() => {
    if (!state.transcript?.length) return;
    const node = conversation.current;
    if (node && followConversation.current) node.scrollTop = node.scrollHeight;
  }, [state.transcript]);
  return (
    <section aria-label="Nia chat" className="flex h-full min-h-0 flex-col bg-background">
      <header
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between border-b bg-background pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          isElectron && "drag-region wco:pr-(--workspace-native-controls-inset)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h1 className="flex items-center gap-2 font-medium">
          <NiaAvatar presence={niaPresence(activity, watch)} />
          Nia
        </h1>
        <Link
          to="/settings/general"
          className="text-sm text-muted-foreground hover:underline [-webkit-app-region:no-drag]"
        >
          Settings
        </Link>
      </header>
      {state.threadId ? (
        <D4AgentPanel environmentId={environmentId} threadId={state.threadId} />
      ) : null}
      <div
        ref={conversation}
        onScroll={(event) => {
          const node = event.currentTarget;
          followConversation.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
        }}
        role="log"
        aria-label="Agent conversation"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-gutter-both px-4 py-6"
      >
        {(state.transcript ?? []).map((entry) => {
          const segments =
            entry.role === "system" ? niaSystemTextSegments(entry.text, entry.links) : null;
          // System text already shows every label; only links it could not place are repeated below.
          const inline = new Set(
            segments?.flatMap((segment) => (segment.kind === "thread" ? [segment.threadId] : [])),
          );
          return (
            <article
              key={entry.id}
              className={
                entry.role === "system"
                  ? "border-y py-2 text-xs text-muted-foreground"
                  : "mx-auto max-w-3xl space-y-2"
              }
            >
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {entry.role === "assistant" ? <NiaAvatar className="size-4" /> : null}
                {entry.role === "user" ? "You" : entry.role === "assistant" ? "Nia" : entry.context}
              </p>
              {entry.role === "assistant" ? (
                // Nia quotes other threads, so their HTML is shown as text, never rendered.
                <ChatMarkdown
                  text={entry.text}
                  cwd={undefined}
                  environmentId={environmentId}
                  lineBreaks={shouldPreserveAssistantLineBreaks(entry.text)}
                  parseRawHtml={false}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words select-text">
                  {segments === null ? (
                    entry.text
                  ) : (
                    <SystemText environmentId={environmentId} segments={segments} />
                  )}
                </p>
              )}
              {entry.attachments?.length ? (
                <ul className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                  {entry.attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      className="max-w-full truncate rounded-lg border px-2 py-1"
                    >
                      {attachment.name}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.links
                .filter(
                  (link) =>
                    segments === null || (link.threadId !== null && !inline.has(link.threadId)),
                )
                .map((link) =>
                  link.threadId ? (
                    <Link
                      key={`${link.label}:${link.threadId ?? link.projectId ?? "label"}`}
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: link.threadId }}
                      className="mr-3 inline-block text-sm text-primary underline underline-offset-2"
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <span
                      key={`${link.label}:${link.threadId ?? link.projectId ?? "label"}`}
                      className="mr-3 text-sm text-muted-foreground"
                    >
                      {link.label}
                    </span>
                  ),
                )}
            </article>
          );
        })}
        {(state.transcript ?? []).length === 0 ? (
          <p className="mx-auto max-w-3xl text-sm text-muted-foreground">
            Ask what needs attention, send a message to a thread, or start research.
          </p>
        ) : null}
      </div>
      <div
        role="status"
        aria-label="Nia activity"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 pt-2 text-xs"
      >
        <span
          className={cn(
            "flex items-center gap-1.5",
            activity.tone === "working" && "font-medium text-foreground",
            activity.tone === "error" && "text-destructive",
            activity.tone === "idle" && "text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              activity.tone === "working" && "bg-primary",
              activity.tone === "error" && "bg-destructive",
              activity.tone === "idle" && "bg-muted-foreground/50",
            )}
          />
          {activity.text}
        </span>
        <span className="text-muted-foreground">
          {watch.text}{" "}
          {watch.off ? (
            <Link to="/settings/general" className="text-primary underline underline-offset-2">
              Turn on
            </Link>
          ) : null}
        </span>
      </div>
      <D4AgentComposer
        key={environmentId}
        environmentId={environmentId}
        state={state}
        active={activity.tone === "working"}
        refresh={refresh}
      />
    </section>
  );
}

/* oxlint-disable react/no-array-index-key -- Segments of one immutable message keep their positions and may repeat. */
// Overview and other server posts are plain text; only their URLs and validated thread
// references become links, so no HTML is ever rendered.
function SystemText({
  environmentId,
  segments,
}: {
  environmentId: EnvironmentId;
  segments: ReadonlyArray<NiaTextSegment>;
}) {
  return segments.map((segment, index) =>
    segment.kind === "url" ? (
      <a
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {segment.text}
      </a>
    ) : segment.kind === "thread" ? (
      <Link
        key={index}
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: segment.threadId }}
        className="text-primary underline underline-offset-2"
      >
        {segment.text}
      </Link>
    ) : (
      segment.text
    ),
  );
}
