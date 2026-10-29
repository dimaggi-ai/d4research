import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/utils";

const Root = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function ComposerFooterRoot({ className, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-chat-composer-footer="true"
        className={cn(
          "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
          className,
        )}
      />
    );
  },
);

const Controls = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function ComposerFooterControls({ className, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-chat-composer-controls="left"
        data-chat-composer-footer-controls="true"
        className={cn(
          "relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
      />
    );
  },
);

const Actions = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function ComposerFooterActions({ className, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-chat-composer-actions="right"
        className={cn("flex shrink-0 flex-nowrap items-center justify-end gap-2", className)}
      />
    );
  },
);

export const ComposerFooter = { Root, Controls, Actions };
