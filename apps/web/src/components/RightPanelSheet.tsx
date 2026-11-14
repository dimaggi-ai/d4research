import { type ReactNode } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  showCloseButton?: boolean;
  /** Keeps the sheet clear of the workspace titlebar controls, which stay on top of docked sheets. */
  belowTitlebar?: boolean;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={props.showCloseButton ?? false}
        keepMounted
        className={[
          "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] pt-safe pr-safe pb-safe max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0",
          props.belowTitlebar
            ? "mt-(--workspace-topbar-height) h-[calc(100%-var(--workspace-topbar-height))] max-h-[calc(100%-var(--workspace-topbar-height))]"
            : "wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]",
        ].join(" ")}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
