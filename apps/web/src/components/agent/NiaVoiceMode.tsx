import type { D4AgentTranscriptEntry, EnvironmentId } from "@d4research/contracts";
import { niaThreadReferenceMarkdown } from "@d4research/client-runtime/d4-agent-references";
import { preparedEnvironmentFetchAuthorization } from "@d4research/client-runtime/state/skills";
import { shouldPreserveAssistantLineBreaks } from "@d4research/shared/markdownPipeline";
import { Link } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  FileTextIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  SparklesIcon,
  SquareIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAssetUrl } from "../../assets/assetUrls";
import type { SpokenVoiceReply, VoiceConversationStatus } from "../../hooks/useVoiceConversation";
import { observeResize } from "../../lib/observeResize";
import { runtime } from "../../lib/runtime";
import { useEnvironmentThreadRefs } from "../../state/entities";
import { readPreparedConnection } from "../../state/session";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { NiaVoiceCore } from "./NiaVoiceCore";
import { niaVoiceArtifacts, niaVoiceStatusCopy, type NiaVoiceArtifact } from "./niaVoiceMode.logic";

const VOICE_SUMMARY_TIMEOUT_MS = 20_000;

/** Gemma summary from the environment's server; null lets the caller fall back. */
export async function requestNiaVoiceSummary(
  environmentId: EnvironmentId,
  text: string,
): Promise<string | null> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) return null;
  const endpoint = new URL("/api/voice/summarize", prepared.httpBaseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_SUMMARY_TIMEOUT_MS);
  try {
    const auth = await runtime.runPromise(
      preparedEnvironmentFetchAuthorization(prepared, "POST", endpoint),
    );
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      ...(auth.credentials ? { credentials: auth.credentials } : {}),
      headers: { "content-type": "application/json", ...auth.headers },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const result = (await response.json().catch(() => null)) as { text?: unknown } | null;
    return typeof result?.text === "string" && result.text.trim() ? result.text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function NiaVoiceMode({
  environmentId,
  entries,
  status,
  levelRef,
  heard,
  spoken,
  hasOriginalReply,
  onStop,
}: {
  environmentId: EnvironmentId;
  /** Transcript entries said since voice mode opened. */
  entries: ReadonlyArray<D4AgentTranscriptEntry>;
  status: VoiceConversationStatus;
  levelRef: RefObject<number>;
  heard: string | null;
  spoken: SpokenVoiceReply | null;
  hasOriginalReply: boolean;
  onStop: () => void;
}) {
  const threadRefs = useEnvironmentThreadRefs(environmentId);
  const knownThreadIds = new Set<string>(threadRefs.map((ref) => ref.threadId));
  const feed = useRef<HTMLDivElement>(null);
  const feedContent = useRef<HTMLDivElement>(null);
  const copy = niaVoiceStatusCopy[status];
  const lastUser = entries.findLast((entry) => entry.role === "user");
  const pendingHeard =
    heard && (status === "transcribing" || status === "waiting") && lastUser?.text !== heard
      ? heard
      : null;
  const detail =
    status === "listening" && hasOriginalReply
      ? "Speak, or say “read the original” to hear the full reply"
      : copy.detail;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the newest bubble in view as markdown and cards grow.
  useLayoutEffect(() => {
    const node = feed.current;
    const lane = feedContent.current;
    if (!node || !lane) return;
    return observeResize(lane, () => {
      const newest = lane.lastElementChild;
      // A reply taller than the feed is pinned at its top, where the spoken summary sits.
      if (newest && newest.getBoundingClientRect().height > node.clientHeight) {
        node.scrollTop +=
          newest.getBoundingClientRect().top - node.getBoundingClientRect().top - 12;
        return;
      }
      node.scrollTop = node.scrollHeight;
    });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a window Escape listener while the overlay is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStop]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Nia voice mode"
      data-nia-voice-mode={status}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background/95 text-foreground backdrop-blur-xl"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_28%,rgb(34_211_238/0.16),transparent_70%),radial-gradient(40%_35%_at_85%_90%,rgb(139_92_246/0.12),transparent_70%)] lg:bg-[radial-gradient(42%_60%_at_24%_50%,rgb(34_211_238/0.16),transparent_70%),radial-gradient(40%_35%_at_85%_90%,rgb(139_92_246/0.12),transparent_70%)]"
      />
      <header className="relative flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>Nia</span>
          <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
            Voice
          </span>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Exit voice mode"
          onClick={onStop}
        >
          <XIcon />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          aria-label="Voice status"
          className="flex shrink-0 flex-col items-center justify-center gap-3 px-4 pb-3 lg:w-[42%] lg:pb-16"
        >
          <NiaVoiceCore
            status={status}
            levelRef={levelRef}
            className="aspect-square w-44 sm:w-56 lg:w-[min(26rem,34vw)]"
          />
          <div role="status" aria-live="polite" className="text-center">
            <div className="text-lg font-semibold tracking-[0.2em] uppercase">{copy.label}</div>
            <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div>
          </div>
        </section>

        <div
          ref={feed}
          className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 lg:py-6 lg:pr-8"
        >
          <div ref={feedContent} className="mx-auto flex max-w-2xl flex-col gap-3">
            {entries.length === 0 && !pendingHeard ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Ask what needs attention, or tell Nia what to do.
              </p>
            ) : null}
            {entries.map((entry) =>
              entry.role === "user" ? (
                <VoiceUserBubble key={entry.id}>{entry.text}</VoiceUserBubble>
              ) : (
                <article
                  key={entry.id}
                  aria-label="Nia reply"
                  className="min-w-0 rounded-2xl border border-cyan-500/20 bg-card/80 p-4 shadow-[0_0_0_1px_rgb(34_211_238/0.04),0_18px_40px_-28px_rgb(34_211_238/0.6)]"
                >
                  {spoken?.messageId === entry.id && spoken.summarized ? (
                    <div className="mb-3 flex gap-2 rounded-xl bg-cyan-500/10 px-3 py-2 text-sm">
                      <Volume2Icon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-cyan-600 dark:text-cyan-300"
                      />
                      <p>
                        <span className="sr-only">Spoken summary: </span>
                        {spoken.text}
                      </p>
                    </div>
                  ) : null}
                  <ChatMarkdown
                    headingLevelOffset={3}
                    text={
                      entry.role === "assistant"
                        ? niaThreadReferenceMarkdown(entry.text, environmentId, knownThreadIds)
                        : entry.text
                    }
                    cwd={undefined}
                    environmentId={environmentId}
                    lineBreaks={shouldPreserveAssistantLineBreaks(entry.text)}
                    parseRawHtml={false}
                  />
                  <VoiceArtifacts environmentId={environmentId} entry={entry} />
                </article>
              ),
            )}
            {pendingHeard ? <VoiceUserBubble pending>{pendingHeard}</VoiceUserBubble> : null}
          </div>
        </div>
      </div>

      <footer className="relative flex justify-center px-4 pt-2 pb-[max(env(safe-area-inset-bottom),1rem)]">
        <Button
          type="button"
          size="lg"
          variant="destructive"
          aria-label="End voice conversation"
          onClick={onStop}
        >
          <SquareIcon />
          End
        </Button>
      </footer>
    </div>,
    document.body,
  );
}

function VoiceUserBubble({ children, pending }: { children: ReactNode; pending?: boolean }) {
  return (
    <div className="flex justify-end">
      <p
        className={
          pending
            ? "max-w-[85%] rounded-2xl rounded-br-md border border-dashed border-border bg-message/60 px-3.5 py-2 text-sm text-message-foreground italic"
            : "max-w-[85%] rounded-2xl rounded-br-md bg-message px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-message-foreground"
        }
      >
        {children}
      </p>
    </div>
  );
}

function VoiceArtifacts({
  environmentId,
  entry,
}: {
  environmentId: EnvironmentId;
  entry: D4AgentTranscriptEntry;
}) {
  const artifacts = niaVoiceArtifacts(entry);
  if (artifacts.length === 0) return null;
  return (
    <ul aria-label="Artifacts" className="mt-3 grid gap-2 sm:grid-cols-2">
      {artifacts.map((artifact) => (
        <li key={artifact.key} className="min-w-0">
          <VoiceArtifactCard environmentId={environmentId} artifact={artifact} />
        </li>
      ))}
    </ul>
  );
}

const ARTIFACT_CARD_CLASS =
  "flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 text-left transition-colors hover:border-cyan-500/50 hover:bg-cyan-500/5";

function ArtifactCardBody({
  icon: Icon,
  kind,
  label,
}: {
  icon: typeof FileTextIcon;
  kind: string;
  label: string;
}) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {kind}
        </span>
        <span className="block truncate text-sm">{label}</span>
      </span>
    </>
  );
}

function VoiceArtifactCard({
  environmentId,
  artifact,
}: {
  environmentId: EnvironmentId;
  artifact: NiaVoiceArtifact;
}) {
  switch (artifact.kind) {
    case "attachment":
      return <AttachmentCard environmentId={environmentId} artifact={artifact} />;
    case "thread":
      return (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: artifact.threadId }}
          className={ARTIFACT_CARD_CLASS}
        >
          <ArtifactCardBody icon={MessagesSquareIcon} kind="Thread" label={artifact.label} />
        </Link>
      );
    case "artifact":
    case "link":
      return (
        <a
          href={artifact.href}
          target="_blank"
          rel="noopener noreferrer"
          className={ARTIFACT_CARD_CLASS}
        >
          <ArtifactCardBody
            icon={artifact.kind === "artifact" ? SparklesIcon : ExternalLinkIcon}
            kind={artifact.kind === "artifact" ? "Artifact" : "Link"}
            label={artifact.label}
          />
        </a>
      );
    case "file":
      // File links keep ChatMarkdown's open/copy behavior instead of a second file opener.
      return (
        <div className={ARTIFACT_CARD_CLASS}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            <FileTextIcon aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 text-sm">
            <span className="block text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              File
            </span>
            <ChatMarkdown
              text={`[${artifact.label.replace(/[[\]]/g, "")}](${artifact.path})`}
              cwd={undefined}
              environmentId={environmentId}
              parseRawHtml={false}
            />
          </span>
        </div>
      );
  }
}

function AttachmentCard({
  environmentId,
  artifact,
}: {
  environmentId: EnvironmentId;
  artifact: Extract<NiaVoiceArtifact, { kind: "attachment" }>;
}) {
  const { attachment } = artifact;
  const url = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  if (attachment.type === "image" && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-xl border border-border/70"
      >
        <img src={url} alt={attachment.name} className="max-h-48 w-full object-cover" />
      </a>
    );
  }
  const body = <ArtifactCardBody icon={PaperclipIcon} kind="Attachment" label={attachment.name} />;
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className={ARTIFACT_CARD_CLASS}>
      {body}
    </a>
  ) : (
    <div className={ARTIFACT_CARD_CLASS}>{body}</div>
  );
}
