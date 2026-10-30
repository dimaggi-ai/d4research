import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  CornerDownLeftIcon,
  CornerUpRightIcon,
  MessageSquareIcon,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@d4research/shared/markdownPipeline";
import {
  communicationStatusTone,
  type CommunicationMessage,
} from "@d4research/client-runtime/state/thread-communication";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { communicationStatusClasses } from "./agentCommunicationStyles";
import { AgentCommunicationAvatar } from "./AgentCommunicationAvatar";

export type CommunicationReadingMode = "compact" | "preview" | "full";
export interface CommunicationMessageAgent {
  readonly id: string;
  readonly label: string;
  readonly coordinator: boolean;
}
const stateLabels = {
  sent: "Sent",
  received: "Received",
  pending: "Sending",
  failed: "Failed",
  recorded: "Recorded",
};
const kinds = {
  delegation: { label: "Assignment", Icon: CornerUpRightIcon },
  response: { label: "Reply", Icon: CornerDownLeftIcon },
  message: { label: "Message", Icon: MessageSquareIcon },
};
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const PREVIEW_HEIGHT_REM = 10;

const fullMarkdownComponents: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt || "Image attachment"}</span>,
};
const previewMarkdownComponents: Components = {
  ...fullMarkdownComponents,
  a: ({ children }) => <span>{children}</span>,
};

function plainText(markdown: string) {
  return markdown
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*\||\|\s*$/gm, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Limit parsing work as well as height: full transcripts mount only when requested. */
export const AgentCommunicationMessage = memo(function AgentCommunicationMessage({
  message,
  from,
  to,
  environment,
  mode: initialMode,
}: {
  message: CommunicationMessage;
  from: CommunicationMessageAgent;
  to: CommunicationMessageAgent;
  environment: string;
  mode: CommunicationReadingMode;
}) {
  const [mode, setMode] = useState(initialMode);
  const [overflows, setOverflows] = useState(false);
  const bodyId = useId();
  const article = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const preview = message.text.slice(0, 1200).split("\n").slice(0, 12).join("\n");
  const compactText =
    (message.summary ? `${message.summary} · ` : "") +
    plainText(message.text.slice(0, 400)).slice(0, 250);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const limit =
      mode === "compact"
        ? element.clientHeight
        : PREVIEW_HEIGHT_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
    setOverflows(element.scrollHeight > limit + 1);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Edited text changes the rendered height.
  }, [mode, message.text]);
  const truncated =
    overflows ||
    preview.length < message.text.length ||
    (mode === "compact" && message.text.length > 250);
  const { label, Icon } = kinds[message.kind];
  const changeMode = () => {
    const next = mode === "full" ? "preview" : "full";
    const feed = article.current?.closest('[aria-label="Messages between agents"]');
    if (
      next === "preview" &&
      article.current &&
      feed &&
      article.current.getBoundingClientRect().top < feed.getBoundingClientRect().top
    )
      article.current.scrollIntoView({ block: "start" });
    setMode(next);
  };
  return (
    <article
      ref={article}
      data-reading-mode={mode}
      className="flex gap-3 border-b border-border/60 py-4 last:border-b-0"
    >
      <AgentCommunicationAvatar
        id={from.id}
        label={from.label}
        coordinator={from.coordinator}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">{from.label}</span>
          <ArrowRightIcon aria-label="to" className="size-3.5 shrink-0 text-muted-foreground" />
          <AgentCommunicationAvatar
            id={to.id}
            label={to.label}
            coordinator={to.coordinator}
            size="xs"
          />
          <span className="text-foreground/85">{to.label}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
            <Icon aria-hidden className="size-3" />
            {label}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1",
              communicationStatusClasses[communicationStatusTone(message.state)],
            )}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {stateLabels[message.state]}
          </span>
          {environment ? <span>{environment}</span> : null}
          <time dateTime={message.at} className="ml-auto whitespace-nowrap tabular-nums">
            {dateFormat.format(new Date(message.at))}
          </time>
        </div>
        {mode !== "compact" && message.summary ? (
          <h4 className="mt-2.5 text-sm font-medium">{message.summary}</h4>
        ) : null}
        {mode === "compact" ? (
          <p ref={body} className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {compactText}
          </p>
        ) : (
          <div
            ref={body}
            id={bodyId}
            className={cn(
              "mt-2",
              mode === "preview" && "max-h-40 overflow-hidden",
              mode === "preview" &&
                truncated &&
                "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
            )}
          >
            <div className="chat-markdown min-w-0 text-sm leading-relaxed text-foreground/85 [overflow-wrap:anywhere] [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
              <ReactMarkdown
                remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
                skipHtml
                components={mode === "full" ? fullMarkdownComponents : previewMarkdownComponents}
              >
                {mode === "full" ? message.text : preview}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {truncated ? (
          <div className="mt-1 -ml-2">
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={mode === "full"}
              aria-controls={mode === "compact" ? undefined : bodyId}
              onClick={changeMode}
            >
              {mode === "full"
                ? "Shorten message"
                : mode === "compact"
                  ? "Read message"
                  : "Show full message"}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
});
