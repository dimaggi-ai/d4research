import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";

export const ChatWorkspaceHeader = forwardRef<
  HTMLElement,
  ComponentPropsWithoutRef<"header"> & { reserveNativeControlsInset?: boolean }
>(function ChatWorkspaceHeader({ className, reserveNativeControlsInset = true, ...props }, ref) {
  return (
    <header
      {...props}
      ref={ref}
      data-chat-header
      className={cn(
        "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        isElectron
          ? cn(
              "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
              reserveNativeControlsInset && "wco:pr-(--workspace-native-controls-inset)",
            )
          : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
    />
  );
});
