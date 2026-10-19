import { FileTextIcon, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type PastedContextDraft, countLines } from "~/lib/pastedContext";

interface ComposerPendingPastedContextsProps {
  contexts: ReadonlyArray<PastedContextDraft>;
  onRemove: (contextId: string) => void;
  memoPersistenceState?: "idle" | "saving" | "failed";
  className?: string;
}

/** "312 lines · 18.4 KB" — enough to judge what is attached without opening it. */
export function formatPastedContextMeta(context: PastedContextDraft): string {
  const lines = countLines(context.content);
  const kb = context.content.length / 1024;
  const size = kb >= 1 ? `${kb.toFixed(1)} KB` : `${context.content.length} chars`;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${size}`;
}

export function memoPastedContextLabel(
  context: PastedContextDraft,
  state: "idle" | "saving" | "failed",
): string | null {
  if (state === "saving") return "Saving to Memo…";
  if (state === "failed") return "Memo failed · retry";
  return context.sourceContent !== undefined || context.contentTruncated === true
    ? "Memo on send"
    : null;
}

function ComposerPendingPastedContextChip({
  context,
  onRemove,
  memoPersistenceState,
}: {
  context: PastedContextDraft;
  onRemove: (contextId: string) => void;
  memoPersistenceState: "idle" | "saving" | "failed";
}) {
  const meta = formatPastedContextMeta(context);
  const memoLabel = memoPastedContextLabel(context, memoPersistenceState);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip kind="file" className="select-none pr-1">
            <FileTextIcon />
            <ContextChipLabel>{context.name}</ContextChipLabel>
            <span className="select-none text-[10px] font-normal leading-tight text-muted-foreground/85">
              {meta}
            </span>
            {memoLabel ? (
              <span
                className={cn(
                  "select-none rounded-sm px-1 py-0.5 text-[9px] font-medium leading-none",
                  memoPersistenceState === "failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary",
                )}
              >
                {memoLabel}
              </span>
            ) : null}
            <ContextChipAction
              aria-label={`Remove ${context.name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <X aria-hidden />
            </ContextChipAction>
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
        {`${context.name}\n${meta}\n\n${context.content.slice(0, 600)}${
          context.content.length > 600 ? "\n…" : ""
        }`}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPendingPastedContexts({
  contexts,
  onRemove,
  memoPersistenceState = "idle",
  className,
}: ComposerPendingPastedContextsProps) {
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingPastedContextChip
          key={context.id}
          context={context}
          onRemove={onRemove}
          memoPersistenceState={memoPersistenceState}
        />
      ))}
    </div>
  );
}
