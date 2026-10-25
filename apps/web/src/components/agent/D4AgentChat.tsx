import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
  type AgentDraftOrigin,
} from "@d4research/client-runtime/d4-agent-references";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects, useThreadShells, useThreadShell } from "../../state/entities";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  D4AgentError,
  type D4AgentState,
  type EnvironmentId,
  type ThreadId,
} from "@d4research/contracts";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import ChatMarkdown from "../ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "@d4research/shared/markdownPipeline";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";

const isD4AgentError = Schema.is(D4AgentError);

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
  const projects = useProjects();
  const threads = useThreadShells();
  const enabled = config?.settings.d4Agent.enabled === true;
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const allowed = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState<AgentDraftOrigin | null>(null);
  if (!text.trim() && origin !== null) setOrigin(null);
  const bindDraft = () => setOrigin((current) => current ?? agentDraftOrigin(state));
  const moved = agentDraftMovedNotice(origin, state);
  const mentions = agentMentionOptions({
    environmentId,
    context: state.brainContext,
    agentProjectId: state.projectId,
    settings: config?.settings,
    projects,
    threads,
    query: agentMentionQuery(text),
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"failed" | "stale" | null>(null);
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
        <h1 className="font-medium">Nia</h1>
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
        {(state.transcript ?? []).map((entry) => (
          <article
            key={entry.id}
            className={
              entry.role === "system"
                ? "border-y py-2 text-xs text-muted-foreground"
                : "mx-auto max-w-3xl space-y-2"
            }
          >
            <p className="text-xs text-muted-foreground">
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
              <p className="whitespace-pre-wrap break-words select-text">{entry.text}</p>
            )}
            {entry.links.map((link) =>
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
        ))}
        {(state.transcript ?? []).length === 0 ? (
          <p className="mx-auto max-w-3xl text-sm text-muted-foreground">
            Ask what needs attention, send a message to a thread, or start research.
          </p>
        ) : null}
      </div>
      <form
        className="shrink-0 space-y-2 border-t p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (sending || !enabled || !allowed || !text.trim() || moved) return;
          const submitted = text;
          const target = origin ?? agentDraftOrigin(state);
          setSending(true);
          setError(null);
          try {
            const result = await send({
              environmentId,
              input: {
                text: submitted.trim(),
                expectedContext: target.context,
                expectedThreadId: target.threadId,
              },
            });
            if (result._tag === "Failure") {
              const failure = squashAtomCommandFailure(result);
              const stale = isD4AgentError(failure) && failure.reason === "stale";
              setError(stale ? "stale" : "failed");
              // The resend must carry the current context and session, not the ones that went stale.
              if (stale) refresh();
            } else {
              setText((current) => (current === submitted ? "" : current));
              refresh();
            }
          } catch {
            setError("failed");
          }
          setSending(false);
        }}
      >
        {agentMentionQuery(text) !== null && enabled && allowed ? (
          <div
            aria-label="Mention a thread, project, or pipeline"
            className="max-h-48 space-y-1 overflow-y-auto"
          >
            {mentions.map((mention) => (
              <div key={`${mention.kind}:${mention.id}`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setText((current) => insertAgentMention(current, mention));
                    bindDraft();
                  }}
                >
                  {mention.kind} · {mention.title}
                </Button>
              </div>
            ))}
            {mentions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matching references.</p>
            ) : null}
          </div>
        ) : null}
        <Textarea
          aria-label="Message Nia"
          value={text}
          maxLength={16000}
          disabled={!enabled || !allowed || sending}
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim()) bindDraft();
          }}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={!enabled || !allowed || sending || !text.trim() || moved !== null}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
        {moved ? (
          <div role="status" className="flex items-center justify-between gap-2 text-sm">
            <p>{moved.message}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOrigin(agentDraftOrigin(state));
                setError(null);
              }}
            >
              {moved.reassignLabel}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error === "stale"
              ? "Not sent: Nia's context or session changed after you wrote this. Your draft is preserved. Check it, then send again."
              : "Could not send this message. Your draft is preserved."}
          </p>
        ) : null}
      </form>
    </section>
  );
}
