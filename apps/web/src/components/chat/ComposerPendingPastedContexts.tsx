import { FileTextIcon, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type PastedContextDraft, countLines } from "~/lib/pastedContext";

interface ComposerPendingPastedContextsProps {
  contexts: ReadonlyArray<PastedContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

/** "312 lines · 18.4 KB" — enough to judge what is attached without opening it. */
export function formatPastedContextMeta(context: PastedContextDraft): string {
  const lines = countLines(context.content);
  const kb = context.content.length / 1024;
  const size = kb >= 1 ? `${kb.toFixed(1)} KB` : `${context.content.length} chars`;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${size}`;
}

function ComposerPendingPastedContextChip({
  context,
  onRemove,
}: {
  context: PastedContextDraft;
  onRemove: (contextId: string) => void;
}) {
  const meta = formatPastedContextMeta(context);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            <FileTextIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{context.name}</span>
            <span className="select-none text-[10px] font-normal leading-tight text-muted-foreground/85">
              {meta}
            </span>
            <button
              type="button"
              aria-label={`Remove ${context.name}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
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
  className,
}: ComposerPendingPastedContextsProps) {
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingPastedContextChip key={context.id} context={context} onRemove={onRemove} />
      ))}
    </div>
  );
}
