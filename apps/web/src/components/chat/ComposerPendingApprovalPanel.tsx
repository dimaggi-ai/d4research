import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      {/* A small window leaves the drawer little height: the reason and the whole request scroll
          here, wrapped, while the decision buttons stay beside them. */}
      <span
        className="flex max-h-[min(40dvh,22rem)] w-full min-w-0 flex-col gap-1.5 overflow-y-auto overscroll-contain [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        tabIndex={0}
      >
        {approval.reason ? (
          <span
            aria-label="Reason"
            className="block whitespace-pre-wrap text-xs text-muted-foreground select-text wrap-anywhere"
          >
            {approval.reason}
          </span>
        ) : null}
        <Detail
          aria-label={detailAriaLabel}
          className={cn(
            "block w-full min-w-0 shrink-0 whitespace-pre-wrap text-xs text-foreground select-text wrap-anywhere",
            approval.requestKind === "mcp-elicitation" ? "font-sans" : "font-mono",
          )}
          data-approval-detail="complete"
        >
          {approval.responseCapability === "not_resumable"
            ? "Provider process is gone. Interrupt or restart the run to respond."
            : approval.detail || fallbackLabel}
        </Detail>
      </span>
    </span>
  );
});
