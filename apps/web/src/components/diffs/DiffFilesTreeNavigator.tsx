import { ChevronRightIcon, FolderClosedIcon, FolderIcon, PanelLeftCloseIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { buildTurnDiffTree, type DiffTreeFile, type TurnDiffTreeNode } from "~/lib/turnDiffTree";
import { cn } from "~/lib/utils";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function DiffFilesTreeNavigator(props: {
  files: ReadonlyArray<DiffTreeFile>;
  resolvedTheme: "light" | "dark";
  selectedPath?: string | null;
  onSelectFile: (path: string) => void;
  onClose?: () => void;
}) {
  const nodes = useMemo(() => buildTurnDiffTree(props.files), [props.files]);
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderNode = (node: TurnDiffTreeNode, depth: number) => {
    const paddingLeft = 8 + depth * 13;
    if (node.kind === "directory") {
      const expanded = !collapsedDirectories.has(node.path);
      return (
        <div key={`directory:${node.path}`}>
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 rounded-md py-1 pe-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ paddingLeft }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            {expanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground">
              {node.name}
            </span>
          </button>
          {expanded ? node.children.map((child) => renderNode(child, depth + 1)) : null}
        </div>
      );
    }

    return (
      <Tooltip key={`file:${node.path}`}>
        <TooltipTrigger
          render={
            <button
              key={`file:${node.path}`}
              type="button"

              className={cn(
                "group flex w-full items-center gap-1.5 rounded-md py-1 pe-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                props.selectedPath === node.path
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60",
              )}
              style={{ paddingLeft: paddingLeft + 18 }}
              onClick={() => props.onSelectFile(node.path)}
            >
              <PierreEntryIcon
                pathValue={node.path}
                kind="file"
                theme={props.resolvedTheme}
                className="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground">
                {node.name}
              </span>
              {node.stat ? (
                <span className="shrink-0 font-mono text-[9px] tabular-nums">
                  <span className="text-green-600 dark:text-green-400">+{node.stat.additions}</span>{" "}
                  <span className="text-red-600 dark:text-red-400">-{node.stat.deletions}</span>
                </span>
              ) : null}
            </button>
          }
        />
        <TooltipPopup>{node.path}</TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-muted/10">
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Changed files
        </span>
        {props.onClose ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="ms-auto"
                  aria-label="Hide changed files tree"
                  onClick={props.onClose}
                />
              }
            >
              <PanelLeftCloseIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Hide files tree</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {nodes.map((node) => renderNode(node, 0))}
      </div>
    </aside>
  );
}
