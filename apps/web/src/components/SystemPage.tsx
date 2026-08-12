import { ActivityIcon } from "lucide-react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { SystemPanel } from "./SystemPanel";
import { SidebarInset } from "./ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "./WorkspaceBreadcrumb";

export function SystemPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron && "drag-region wco:h-[env(titlebar-area-height)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="System Monitor breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <ActivityIcon className="size-3.5" aria-hidden />
              System Monitor
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        <SystemPanel />
      </div>
    </SidebarInset>
  );
}
