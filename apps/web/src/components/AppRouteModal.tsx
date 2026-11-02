import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Settings and Usage keep the main sidebar available. Esc and the close button return
 * to the page that opened them. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts.
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  const [paneElement, setPaneElement] = useState<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      // Sidebar navigation must not dismiss the page before its destination is selected.
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <SidebarInset ref={setPaneElement}>
        {paneElement ? (
          <DialogPrimitive.Portal container={paneElement} className="contents">
            <DialogPrimitive.Popup
              ref={popupRef}
              initialFocus={popupRef}
              finalFocus={false}
              aria-label={label}
              data-slot="dialog-popup"
              data-app-modal=""
              className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground outline-none max-md:pt-[var(--workspace-topbar-height)] [-webkit-app-region:no-drag]"
            >
              {children}
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        ) : null}
      </SidebarInset>
    </DialogPrimitive.Root>
  );
}

export function AppRouteModalClose() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label="Close"
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
