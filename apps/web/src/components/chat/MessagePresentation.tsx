import type { EnvironmentId, ScopedThreadRef, ServerProviderSkill } from "@d4research/contracts";
import type { TimestampFormat } from "@d4research/contracts/settings";
import { memo, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown, { type ChatMarkdownContextReference } from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findRevealRef } from "./markdownFindContext";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  resolveAssistantMessageCopyState,
  shouldCollapseUserMessage,
} from "./MessagesTimeline.logic";

export const MESSAGE_HEADING_LEVEL = 3;

export function UserMessageBubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AssistantMessageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("relative min-w-0 px-1 py-0.5", className)}>{children}</div>;
}

export function UserMessageMeta({
  createdAt,
  timestampFormat,
  children,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(createdAt, timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
        </Tooltip>
        <div className="flex items-center gap-0.5">{children}</div>
      </div>
    </div>
  );
}

export function AssistantMessageMeta({
  className,
  status,
  actions,
  timestampFormat,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  status?: string | undefined;
  actions?: ReactNode;
  timestampFormat: TimestampFormat;
  message: Pick<ChatMessage, "text" | "updatedAt" | "streaming">;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {status && status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {actions}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: Pick<ChatMessage, "text" | "updatedAt" | "streaming">;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;

const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

export const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealForFind = () => setExpanded(true);
  const revealRef = findRevealRef(revealForFind);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  const showCollapseControl = canCollapse;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            renderContextReference={props.renderContextReference}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
            threadRef={props.threadRef}
            environmentId={props.environmentId}
          />
        </div>
      ) : null}
      {showCollapseControl || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            showCollapseControl && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {showCollapseControl ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
}) {
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={props.threadRef}
      environmentId={props.environmentId}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
      parseRawHtml={false}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});
