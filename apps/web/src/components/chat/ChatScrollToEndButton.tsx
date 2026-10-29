import { ChevronDownIcon } from "lucide-react";

export function ChatScrollToEndButton({
  bottom,
  onClick,
}: {
  bottom: number;
  onClick: () => void;
}) {
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
      style={{ bottom }}
    >
      <button
        type="button"
        aria-label="Scroll to end"
        onClick={onClick}
        className="bg-background pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground shadow-sm hover:border-border hover:text-foreground"
      >
        <ChevronDownIcon className="size-3.5" />
        Scroll to end
      </button>
    </div>
  );
}
