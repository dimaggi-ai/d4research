import { observeResize } from "../../lib/observeResize";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useAssetUrl } from "../../assets/assetUrls";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import {
  type ChatAttachment,
  type D4AgentState,
  type EnvironmentId,
  type ThreadId,
} from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "@d4research/shared/markdownPipeline";
import {
  niaSystemTextSegments,
  type NiaTextSegment,
} from "@d4research/client-runtime/d4-agent-references";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";
import {
  agentActivityLabel,
  agentWatchLabel,
  isSessionNotice,
  niaPresence,
} from "./d4AgentPresentation";
import { NiaAvatar } from "./NiaAvatar";

import { DEFAULT_SERVER_SETTINGS } from "@d4research/contracts";
import { useMergedSettings } from "../../hooks/useSettings";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import {
  AssistantMessageBody,
  CollapsibleUserMessageBody,
  UserMessageMeta,
  AssistantMessageMeta,
  UserMessageBubble,
} from "../chat/MessagePresentation";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { ChatCanvas } from "../chat/ChatCanvas";
import { ChatScrollToEndButton } from "../chat/ChatScrollToEndButton";
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
  const settings = useMergedSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS);
  const transcript = (state.transcript ?? []).filter((entry) => !isSessionNotice(entry));
  const conversation = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLElement | null>(null);
  const registerComposer = useCallback((node: HTMLDivElement | null) => {
    composer.current = node;
    setComposerOverlayElement(node);
  }, []);
  const [composerInset, setComposerInset] = useState(0);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    return observeResize(node, () => setComposerInset(node.getBoundingClientRect().height));
  }, []);
  const followConversation = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  // A width change or late-rendering markdown reflows the transcript without changing it; a
  // reader at the end stays there.
  useLayoutEffect(() => {
    const node = conversation.current;
    const lane = content.current;
    if (!node || !lane) return;
    const keepEnd = () => {
      if (followConversation.current) node.scrollTop = node.scrollHeight;
    };
    const stopLane = observeResize(lane, keepEnd);
    const stopNode = observeResize(node, keepEnd);
    return () => {
      stopLane();
      stopNode();
    };
  }, []);
  useEffect(() => {
    if (!state.transcript?.length || composerInset === 0) return;
    const node = conversation.current;
    if (node && followConversation.current) node.scrollTop = node.scrollHeight;
  }, [state.transcript, composerInset]);
  return (
    <D4AgentPanel
      environmentId={environmentId}
      threadId={state.threadId}
      render={({ approvals, details }) => (
        <section
          aria-label="Nia chat"
          className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden bg-background"
        >
          <ChatWorkspaceHeader className="justify-between">
            <WorkspaceBreadcrumb ariaLabel="Active thread">
              <WorkspaceBreadcrumbItem current>
                <span className="mr-2">
                  <NiaAvatar presence={niaPresence(activity, watch)} />
                </span>
                <WorkspaceBreadcrumbText>Nia</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <NiaRoutines environmentId={environmentId} state={state} />
          </ChatWorkspaceHeader>
          <ChatCanvas composerOverlayElement={composerOverlayElement}>
            <div
              ref={conversation}
              onScroll={(event) => {
                const node = event.currentTarget;
                followConversation.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 64;
                setShowScrollToEnd(!followConversation.current);
              }}
              role="log"
              aria-label="Agent conversation"
              className="messages-timeline-scroll scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain topbar-scroll-fade [overflow-anchor:none]"
            >
              <div ref={content} className="chat-content-lane flex min-h-full flex-col">
                <div aria-hidden className="h-3 shrink-0 sm:h-4" />
                {transcript.map((entry) => {
                  const segments =
                    entry.role === "system" ? niaSystemTextSegments(entry.text, entry.links) : null;
                  // System text already shows every label; only links it could not place are repeated below.
                  const inline = new Set(
                    segments?.flatMap((segment) =>
                      segment.kind === "thread" ? [segment.threadId] : [],
                    ),
                  );
                  const extras = (
                    <>
                      {entry.attachments?.length ? (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {entry.attachments.map((attachment) => (
                            <NiaAttachment
                              key={attachment.id}
                              environmentId={environmentId}
                              attachment={attachment}
                            />
                          ))}
                        </div>
                      ) : null}
                      {entry.links
                        .filter(
                          (link) =>
                            segments === null ||
                            (link.threadId !== null && !inline.has(link.threadId)),
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
                    </>
                  );
                  return entry.role === "user" ? (
                    <article key={entry.id} className="group flex flex-col items-end gap-1 pb-3">
                      <UserMessageBubble>
                        <h3 className="sr-only select-none">You</h3>
                        {extras}
                        <CollapsibleUserMessageBody
                          text={entry.text}
                          skills={[]}
                          markdownCwd={undefined}
                          environmentId={environmentId}
                        />
                      </UserMessageBubble>
                      <UserMessageMeta
                        createdAt={entry.createdAt}
                        timestampFormat={settings.timestampFormat}
                      >
                        <MessageCopyButton text={entry.text} variant="ghost" />
                      </UserMessageMeta>
                    </article>
                  ) : entry.role === "assistant" ? (
                    <article key={entry.id} className="group/assistant min-w-0 pb-4">
                      <AssistantMessageBody>
                        <h3 className="sr-only select-none">Nia</h3>
                        {/* Nia quotes other threads, so their HTML is shown as text, never rendered. */}
                        <ChatMarkdown
                          headingLevelOffset={3}
                          text={entry.text}
                          cwd={undefined}
                          environmentId={environmentId}
                          lineBreaks={shouldPreserveAssistantLineBreaks(entry.text)}
                          parseRawHtml={false}
                        />
                        {extras}
                        <AssistantMessageMeta
                          className="mt-1.5"
                          message={{
                            text: entry.text,
                            updatedAt: entry.createdAt,
                            streaming: false,
                          }}
                          timestampFormat={settings.timestampFormat}
                          showCopyButton
                          copyStreaming={false}
                          alwaysVisible
                        />
                      </AssistantMessageBody>
                    </article>
                  ) : (
                    <article key={entry.id} className="pb-4">
                      <div className="px-1 py-2 text-sm text-muted-foreground">
                        <p className="whitespace-pre-wrap break-words select-text">
                          {segments === null ? (
                            entry.text
                          ) : (
                            <SystemText environmentId={environmentId} segments={segments} />
                          )}
                        </p>
                        {extras}
                        <AssistantMessageMeta
                          className="mt-1.5"
                          message={{
                            text: entry.text,
                            updatedAt: entry.createdAt,
                            streaming: false,
                          }}
                          timestampFormat={settings.timestampFormat}
                          showCopyButton={false}
                          copyStreaming={false}
                          alwaysVisible
                        />
                      </div>
                    </article>
                  );
                })}
                {transcript.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-center text-sm text-muted-foreground/30">
                      Ask what needs attention, send a message to a thread, or start research.
                    </p>
                  </div>
                ) : null}
                {activity.tone !== "idle" ? (
                  <p
                    role="status"
                    aria-label="Nia activity"
                    className="px-1 py-2 text-xs text-muted-foreground"
                  >
                    {activity.text}
                  </p>
                ) : null}
                <div aria-hidden className="shrink-0" style={{ height: composerInset }} />
                <div aria-hidden className="h-3 shrink-0 sm:h-4" />
              </div>
            </div>
            {showScrollToEnd ? (
              <ChatScrollToEndButton
                bottom={composerInset + 4}
                onClick={() => {
                  const node = conversation.current;
                  if (node) node.scrollTop = node.scrollHeight;
                  followConversation.current = true;
                  setShowScrollToEnd(false);
                }}
              />
            ) : null}
            <div
              ref={registerComposer}
              data-chat-composer-overlay="true"
              className="chat-composer-lane pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-3 sm:pb-4"
            >
              <div className="pointer-events-auto mx-auto w-full max-w-(--chat-content-max-width)">
                {details}
                <D4AgentComposer
                  key={environmentId}
                  environmentId={environmentId}
                  state={state}
                  active={activity.tone === "working"}
                  refresh={refresh}
                  banner={approvals}
                />
              </div>
            </div>
          </ChatCanvas>
        </section>
      )}
    />
  );
}

function NiaAttachment({
  environmentId,
  attachment,
}: {
  environmentId: EnvironmentId;
  attachment: ChatAttachment;
}) {
  const url = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  const content =
    attachment.type === "image" && url ? (
      <img
        src={url}
        alt={attachment.name}
        className="max-h-[120px] max-w-[100px] rounded-lg object-cover"
      />
    ) : (
      <span className="max-w-full truncate text-xs">{attachment.name}</span>
    );
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-full rounded-lg border border-border/80 bg-background/70 p-1"
    >
      {content}
    </a>
  ) : (
    content
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
