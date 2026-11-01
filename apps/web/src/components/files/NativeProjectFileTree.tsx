import type { ProjectEntry } from "@d4research/contracts";
import { ChevronRightIcon, FolderClosedIcon, FolderOpenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  composerMentionFromTreePath,
} from "~/components/chat/composerMentionDrag";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import * as Schema from "effect/Schema";

const ExpandedFileDirectories = Schema.Array(Schema.String);
const EMPTY_EXPANDED_FILE_DIRECTORIES: readonly string[] = [];

interface DirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly ignored: boolean;
  readonly children: ReadonlyArray<ProjectTreeNode>;
}

interface FileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly ignored: boolean;
}

type ProjectTreeNode = DirectoryNode | FileNode;

interface MutableDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  ignored: boolean;
  directories: Map<string, MutableDirectoryNode>;
  files: Map<string, FileNode>;
}

function pathSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

function compareNodes(left: ProjectTreeNode, right: ProjectTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function buildProjectTree(entries: ReadonlyArray<ProjectEntry>): ProjectTreeNode[] {
  const root: MutableDirectoryNode = {
    kind: "directory",
    name: "",
    path: "",
    ignored: false,
    directories: new Map(),
    files: new Map(),
  };

  const directory = (segments: ReadonlyArray<string>, ignored: boolean) => {
    let current = root;
    for (const segment of segments) {
      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      let next = current.directories.get(segment);
      if (!next) {
        next = {
          kind: "directory",
          name: segment,
          path: nextPath,
          ignored,
          directories: new Map(),
          files: new Map(),
        };
        current.directories.set(segment, next);
      } else if (!ignored) {
        next.ignored = false;
      }
      current = next;
    }
    return current;
  };

  for (const entry of entries) {
    const segments = pathSegments(entry.path);
    if (segments.length === 0) continue;
    if (entry.kind === "directory") {
      directory(segments, entry.ignored === true);
      continue;
    }
    const parent = directory(segments.slice(0, -1), entry.ignored === true);
    const name = segments.at(-1);
    if (!name) continue;
    parent.files.set(name, {
      kind: "file",
      name,
      path: segments.join("/"),
      ignored: entry.ignored === true,
    });
  }

  const finish = (node: MutableDirectoryNode): DirectoryNode => ({
    kind: "directory",
    name: node.name,
    path: node.path,
    ignored: node.ignored,
    children: [...Array.from(node.directories.values(), finish), ...node.files.values()].toSorted(
      compareNodes,
    ),
  });

  return [...finish(root).children];
}

function filterTree(nodes: ReadonlyArray<ProjectTreeNode>, query: string): ProjectTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...nodes];
  return nodes.flatMap((node): ProjectTreeNode[] => {
    if (node.kind === "file") {
      return node.path.toLocaleLowerCase().includes(normalized) ? [node] : [];
    }
    const children = filterTree(node.children, normalized);
    return children.length > 0 || node.path.toLocaleLowerCase().includes(normalized)
      ? [{ ...node, children: children.length > 0 ? children : node.children }]
      : [];
  });
}

/**
 * Every directory between the workspace root and `path`, excluding the entry itself. Expanding
 * exactly this set is what keeps one file reachable while the rest of the tree stays shut.
 */
export function ancestorDirectories(path: string): string[] {
  const segments = pathSegments(path);
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment;
    ancestors.push(current);
  }
  return ancestors;
}

interface VisibleProjectTreeRow {
  readonly node: ProjectTreeNode;
  readonly depth: number;
}

const TREE_ROW_HEIGHT = 24;
const TREE_OVERSCAN_ROWS = 12;

function flattenVisibleNodes(
  nodes: ReadonlyArray<ProjectTreeNode>,
  expanded: ReadonlySet<string>,
  forceExpanded: boolean,
  depth = 0,
): VisibleProjectTreeRow[] {
  const rows: VisibleProjectTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && (forceExpanded || expanded.has(node.path))) {
      rows.push(...flattenVisibleNodes(node.children, expanded, forceExpanded, depth + 1));
    }
  }
  return rows;
}

export function NativeProjectFileTree(props: {
  active: boolean;
  workspaceKey: string;
  entries: ReadonlyArray<ProjectEntry>;
  loadingDirectories?: ReadonlySet<string>;
  fileColors?: ReadonlyMap<string, string>;
  expandAllRequestId?: number;
  query: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  selectedPaths: ReadonlyArray<string>;
  resolvedTheme: "light" | "dark";
  onOpenFile: (path: string) => void;
  mentionPath?: (path: string) => string;
  onSelectionChange: (paths: ReadonlyArray<string>) => void;
  onDeleteSelected: () => void | Promise<void>;
  onDeleteEntry?: (path: string) => void | Promise<void>;
  onContextMenu: (path: string, position: { x: number; y: number }) => void;
  collapseRequestId: number;
  onExpandedDirectoriesChange?: (paths: readonly string[]) => void;
}) {
  const nodes = useMemo(() => buildProjectTree(props.entries), [props.entries]);
  const filteredNodes = useMemo(() => filterTree(nodes, props.query), [nodes, props.query]);
  // Expansion is opt-in: a fresh tree shows only top-level entries, so opening a large
  // workspace never flattens tens of thousands of rows into the virtualizer.
  const [expandedPaths, setExpandedPaths] = useLocalStorage(
    `t3code.files.expansion.v1:${props.workspaceKey}`,
    EMPTY_EXPANDED_FILE_DIRECTORIES,
    ExpandedFileDirectories,
  );
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const setExpanded = useCallback(
    (update: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => {
      setExpandedPaths((current) => [
        ...(typeof update === "function" ? update(new Set(current)) : update),
      ]);
    },
    [setExpandedPaths],
  );
  const visibleRows = useMemo(
    () => flattenVisibleNodes(filteredNodes, expanded, props.query.trim().length > 0),
    [expanded, filteredNodes, props.query],
  );
  const visibleFiles = useMemo(
    () => visibleRows.flatMap(({ node }) => (node.kind === "file" ? [node.path] : [])),
    [visibleRows],
  );
  const visibleExpandedDirectories = useMemo(
    () =>
      visibleRows.flatMap(({ node }) =>
        node.kind === "directory" && expanded.has(node.path) ? [node.path] : [],
      ),
    [expanded, visibleRows],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Report expanded directories to the parent that loads their filesystem entries.
  useEffect(() => {
    props.onExpandedDirectoriesChange?.(visibleExpandedDirectories);
  }, [props.onExpandedDirectoriesChange, visibleExpandedDirectories]);
  const selectedPathSet = useMemo(() => new Set(props.selectedPaths), [props.selectedPaths]);
  const selectionAnchorRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the DOM viewport height for file-row virtualization.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const updateHeight = () => {
      setViewport((current) =>
        current.height === scrollElement.clientHeight
          ? current
          : { ...current, height: scrollElement.clientHeight },
      );
    };
    updateHeight();
    return observeResize(scrollElement, updateHeight);
  }, []);

  // Collapse keeps the open file reachable rather than shutting the tree down to nothing,
  // which is the state you'd immediately have to click back out of.
  const expandAllRef = useRef(false);
  const lastExpandAllRequestRef = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Expand folders as asynchronous directory listings arrive after Expand all.
  useEffect(() => {
    if (!props.active) return;
    const requestId = props.expandAllRequestId ?? 0;
    if (requestId !== lastExpandAllRequestRef.current) {
      lastExpandAllRequestRef.current = requestId;
      expandAllRef.current = true;
    }
    if (!expandAllRef.current) return;
    const paths: string[] = [];
    const visit = (entries: readonly ProjectTreeNode[]) => {
      for (const node of entries) {
        if (node.kind !== "directory" || node.ignored) continue;
        paths.push(node.path);
        visit(node.children);
      }
    };
    visit(nodes);
    setExpanded((current) => {
      if (paths.every((path) => current.has(path))) return current;
      return new Set([...current, ...paths]);
    });
  }, [nodes, props.active, props.expandAllRequestId, setExpanded]);
  const lastCollapseRequestRef = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply an external collapse request from the Files toolbar.
  useEffect(() => {
    if (props.collapseRequestId === 0) return;
    if (lastCollapseRequestRef.current === props.collapseRequestId) return;
    lastCollapseRequestRef.current = props.collapseRequestId;
    expandAllRef.current = false;
    setExpanded(new Set(props.selectedPath ? ancestorDirectories(props.selectedPath) : []));
  }, [props.collapseRequestId, props.selectedPath]);

  // Revealing a file expands its own ancestors and nothing else. It used to replace the expanded
  // set, so opening a file in one directory shut every directory the reader had opened elsewhere.
  // Collapsing the tree is the collapse button's job.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reveal the selected file when navigation changes outside the tree.
  useEffect(() => {
    if (!props.active || !props.selectedPath) return;
    const ancestors = ancestorDirectories(props.selectedPath);
    setExpanded((current) => {
      if (ancestors.every((directory) => current.has(directory))) return current;
      const next = new Set(current);
      for (const directory of ancestors) next.add(directory);
      return next;
    });
    props.onSelectionChange([props.selectedPath]);
  }, [props.active, props.selectedPath, props.selectedPathRevealId, setExpanded]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the DOM viewport to the file requested by external navigation.
  useEffect(() => {
    if (!props.active || !props.selectedPath) return;
    const index = visibleRows.findIndex(({ node }) => node.path === props.selectedPath);
    const scrollElement = scrollRef.current;
    if (index < 0 || !scrollElement) return;
    const rowTop = index * TREE_ROW_HEIGHT;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (rowTop < scrollElement.scrollTop) scrollElement.scrollTop = rowTop;
    else if (rowBottom > scrollElement.scrollTop + scrollElement.clientHeight) {
      scrollElement.scrollTop = rowBottom - scrollElement.clientHeight;
    }
  }, [props.active, props.selectedPath, props.selectedPathRevealId, visibleRows]);

  const selectFile = useCallback(
    (path: string, event: React.MouseEvent<HTMLButtonElement>) => {
      if (draggingRef.current) return;
      const additive = event.metaKey || event.ctrlKey;
      if (event.shiftKey && selectionAnchorRef.current) {
        const start = visibleFiles.indexOf(selectionAnchorRef.current);
        const end = visibleFiles.indexOf(path);
        if (start >= 0 && end >= 0) {
          const range = visibleFiles.slice(Math.min(start, end), Math.max(start, end) + 1);
          props.onSelectionChange(
            additive ? Array.from(new Set([...props.selectedPaths, ...range])) : range,
          );
          return;
        }
      }
      selectionAnchorRef.current = path;
      if (additive) {
        props.onSelectionChange(
          props.selectedPaths.includes(path)
            ? props.selectedPaths.filter((selected) => selected !== path)
            : [...props.selectedPaths, path],
        );
        return;
      }
      props.onSelectionChange([path]);
      props.onOpenFile(path);
    },
    [props, visibleFiles],
  );

  const renderRow = ({ node, depth }: VisibleProjectTreeRow, index: number): React.ReactNode => {
    const paddingLeft = 8 + depth * 14;
    const rowStyle = {
      height: TREE_ROW_HEIGHT,
      left: 4,
      paddingLeft,
      position: "absolute" as const,
      right: 4,
      top: index * TREE_ROW_HEIGHT,
    };
    if (node.kind === "directory") {
      const isExpanded = props.query.trim().length > 0 || expanded.has(node.path);
      return (
        <button
          key={`directory:${node.path}`}
          type="button"
          className={cn(
            "flex w-auto items-center gap-1.5 rounded-md pe-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            node.ignored && "opacity-45",
          )}
          style={rowStyle}
          onClick={() => {
            expandAllRef.current = false;
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            });
          }}
          onKeyDown={(event) => {
            if ((event.key === "Delete" || event.key === "Backspace") && props.onDeleteEntry) {
              event.preventDefault();
              event.stopPropagation();
              void props.onDeleteEntry(node.path);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onContextMenu(node.path, { x: event.clientX, y: event.clientY });
          }}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded && props.loadingDirectories?.has(node.path) ? (
            <Spinner size="sm" />
          ) : isExpanded ? (
            <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-xs text-muted-foreground">{node.name}</span>
        </button>
      );
    }

    const selected = selectedPathSet.has(node.path);
    return (
      <Tooltip key={`file:${node.path}`}>
        <TooltipTrigger
          render={
            <button
              type="button"
              draggable
              data-item-path={node.path}
              className={cn(
                "flex w-auto items-center gap-1.5 rounded-md pe-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                node.ignored && "opacity-45",
              )}
              style={{ ...rowStyle, paddingLeft: paddingLeft + 18 }}
              onClick={(event) => selectFile(node.path, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(node.path, { x: event.clientX, y: event.clientY });
              }}
              onDragEnd={() => {
                draggingRef.current = false;
              }}
              onDragStart={(event) => {
                const paths = selectedPathSet.has(node.path) ? props.selectedPaths : [node.path];
                const mentions = paths
                  .map((path) => composerMentionFromTreePath(props.mentionPath?.(path) ?? path))
                  .filter(Boolean)
                  .join(" ");
                if (!mentions) return;
                draggingRef.current = true;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(COMPOSER_MENTION_DRAG_TYPE, mentions);
              }}
            />
          }
        >
          <PierreEntryIcon
            pathValue={node.path}
            kind="file"
            theme={props.resolvedTheme}
            className="size-3.5"
          />
          <span
            style={{ color: props.fileColors?.get(node.path) }}
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground"
          >
            {node.name}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">{node.path}</TooltipPopup>
      </Tooltip>
    );
  };

  const firstRenderedIndex = Math.max(
    0,
    Math.floor(viewport.scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN_ROWS,
  );
  const lastRenderedIndex = Math.min(
    visibleRows.length,
    Math.ceil((viewport.scrollTop + viewport.height) / TREE_ROW_HEIGHT) + TREE_OVERSCAN_ROWS,
  );
  const renderedRows = visibleRows.slice(firstRenderedIndex, lastRenderedIndex);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      role="tree"
      tabIndex={0}
      aria-label="Project files"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key !== "Backspace") return;
        event.preventDefault();
        event.stopPropagation();
        void props.onDeleteSelected();
      }}
      onScroll={(event) => {
        const scrollTop = event.currentTarget.scrollTop;
        setViewport((current) =>
          current.scrollTop === scrollTop ? current : { ...current, scrollTop },
        );
      }}
    >
      {visibleRows.length > 0 ? (
        <div className="relative" style={{ height: visibleRows.length * TREE_ROW_HEIGHT }}>
          {renderedRows.map((row, offset) => renderRow(row, firstRenderedIndex + offset))}
        </div>
      ) : (
        <div className="p-3 text-xs text-muted-foreground">No matching files.</div>
      )}
    </div>
  );
}
