import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

// Keep a user's choice when timeline virtualization unmounts a row. This is
// presentation state for this client session, never a change to the message.
const collapsedImages = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function CollapsibleChatImage({
  imageKey,
  label,
  children,
}: {
  imageKey: string;
  label: string;
  children: ReactNode;
}) {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => collapsedImages.has(imageKey),
    () => false,
  );
  const Icon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <span className="block min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Show" : "Hide"} image: ${label || "Image"}`}
        className="flex max-w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={(event) => {
          event.stopPropagation();
          if (collapsed) collapsedImages.delete(imageKey);
          else collapsedImages.add(imageKey);
          for (const listener of listeners) listener();
        }}
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0">{collapsed ? "Show image" : "Hide image"}</span>
        {collapsed && label ? <span className="truncate opacity-70">{label}</span> : null}
      </button>
      {collapsed ? null : children}
    </span>
  );
}
