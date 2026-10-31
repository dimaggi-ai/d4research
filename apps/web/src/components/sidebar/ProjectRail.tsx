import "./projectRail.css";

import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { ChevronDownIcon, LayersIcon, LayoutDashboardIcon, EllipsisIcon } from "lucide-react";
import type { ContextMenuItem, EnvironmentId, EnvironmentMachineKind } from "@d4research/contracts";

import { openCommandPalette } from "../../commandPaletteBus";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarProjectScope } from "../../hooks/useSidebarProjectScope";
import { readLocalApi } from "../../localApi";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  getSidebarProjectSettingsKey,
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects, useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  combineProjectRailStatuses,
  EMPTY_PROJECT_RAIL_STATUS,
  projectRailStatuses,
  projectRailStatusLabel,
  railGroupStatusSummary,
  type ProjectRailStatus,
} from "./projectRail.logic";
import {
  addToRailGroup,
  buildRailLayout,
  canMoveRailGroup,
  canMoveRailProject,
  createRailGroup,
  findRailGroupOf,
  flattenRailModel,
  moveRailTokenToEnd,
  nextRailGroupColor,
  placeRailProject,
  placeRailToken,
  railGroupIdFromScopeKey,
  railGroupName,
  railGroupScopeKey,
  railGroupShortLabel,
  railModelFromLayout,
  railTopTokenOf,
  recolorRailGroup,
  removeFromRailGroup,
  renameRailGroup,
  setAllRailGroupsCollapsed,
  setRailGroupCollapsed,
  ungroupRailGroup,
  type RailEntry,
  type RailGroup,
  type RailGroupColor,
  type RailModel,
} from "./projectRailGroups.logic";
import { RailGroupEditorPopover, RailNewGroupPopover } from "./ProjectRailGroupPopovers";
import { useProjectRailGroupsStore } from "./projectRailGroupsStore";
import {
  buildRailBackgroundMenu,
  buildRailGroupMenu,
  buildRailProjectMenu,
  railGroupSwatchHex,
} from "./projectRailMenus";
import {
  clampProjectRailNamedWidth,
  PROJECT_RAIL_MAX_NAMED_WIDTH,
  PROJECT_RAIL_MIN_NAMED_WIDTH,
  PROJECT_RAIL_SHORT_WIDTH,
  PROJECT_RAIL_SNAP_WIDTH,
  resolveProjectRailWidth,
  useProjectRailDragWidth,
  useProjectRailLayout,
  useProjectRailVisible,
} from "./projectRailVisibility";
import { useSidebarProjectGroups } from "./useSidebarProjectGroups";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../../state/environments";

const ITEM_CLASS =
  // The focus ring is inset: an offset ring would sit on the neighbouring
  // project in a column this narrow.
  "relative grid size-9 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border border-transparent text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:border-sidebar-border aria-[current=true]:bg-sidebar-row-selected aria-[current=true]:text-sidebar-foreground";

const ROW_CLASS =
  "relative flex h-7.5 w-full shrink-0 cursor-pointer items-center gap-2 rounded-md border border-transparent ps-2 pe-2 text-left text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:border-sidebar-border aria-[current=true]:bg-sidebar-row-selected";

/** Every project icon gets the same box, whatever shape its favicon is. */
const ICON_BOX_CLASS = "grid size-4.5 shrink-0 place-items-center overflow-hidden";

const RESIZE_STEP = 16;

type DropPosition = "before" | "after" | "into";
interface DropTarget {
  readonly id: string;
  readonly position: DropPosition;
}

interface RailEnvironmentSection {
  readonly key: string;
  readonly label: string;
  readonly machine: EnvironmentMachineKind | null;
  readonly entries: ReadonlyArray<RailEntry>;
}

function railEntryEnvironmentId(
  entry: RailEntry,
  snapshotByKey: ReadonlyMap<string, SidebarProjectSnapshot>,
): EnvironmentId | null {
  const keys = entry.kind === "project" ? [entry.key] : entry.members;
  const environmentIds = new Set(
    keys.flatMap(
      (key) => snapshotByKey.get(key)?.memberProjects.map((project) => project.environmentId) ?? [],
    ),
  );
  return environmentIds.size === 1 ? ([...environmentIds][0] ?? null) : null;
}

function RailEnvironmentHeader({
  label,
  machine,
  named,
}: {
  readonly label: string;
  readonly machine: EnvironmentMachineKind | null;
  readonly named: boolean;
}) {
  const icon = machine ? (
    <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3.5" />
  ) : (
    <LayersIcon aria-hidden className="size-3.5" />
  );
  if (named)
    return (
      <div className="flex h-7 items-center gap-2 px-2 text-2xs font-semibold tracking-wide text-sidebar-muted-foreground">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="grid size-7 place-items-center text-sidebar-muted-foreground"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function menuPosition(event: React.MouseEvent<HTMLElement>) {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.right, y: rect.top };
}

function newRailGroupId() {
  return `rg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function StatusDots({
  status,
  className,
  row = false,
  part,
}: {
  status: ProjectRailStatus;
  className?: string;
  row?: boolean;
  part?: string;
}) {
  if (!status.running && !status.monitoring && !status.completed && !status.input) return null;
  return (
    <span
      aria-hidden="true"
      data-rail={part}
      className={cn("flex gap-0.5", row ? "flex-row" : "flex-col", className)}
    >
      {status.running || status.monitoring ? (
        <span
          data-rail="dot"
          data-pulse={status.running || undefined}
          className="size-1.5 rounded-full bg-primary"
        />
      ) : null}
      {status.completed ? (
        <span data-rail="dot" className="size-1.5 rounded-full bg-success" />
      ) : null}
      {status.input ? (
        <span data-rail="dot" className="size-1.5 rounded-full bg-agent-input" />
      ) : null}
    </span>
  );
}

function useRailDnd(id: string, disabled: boolean) {
  const draggable = useDraggable({ id, disabled });
  const droppable = useDroppable({ id, disabled });
  const setNodeRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };
  return {
    setNodeRef,
    attributes: draggable.attributes,
    listeners: draggable.listeners,
    isDragging: draggable.isDragging,
  };
}

interface RailItemProps {
  project: SidebarProjectSnapshot;
  status: ProjectRailStatus;
  isCurrent: boolean;
  index: number;
  named: boolean;
  inert: boolean;
  drop: DropPosition | null;
  onSelect: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  onMove: (direction: -1 | 1) => void;
}

function RailProjectItem({
  project,
  status,
  isCurrent,
  index,
  named,
  inert,
  drop,
  onSelect,
  onContextMenu,
  onMove,
}: RailItemProps) {
  const { setNodeRef, attributes, listeners, isDragging } = useRailDnd(
    `p:${project.projectKey}`,
    inert,
  );
  const statusLabel = projectRailStatusLabel(status);
  const label = statusLabel ? `${project.displayName}: ${statusLabel}` : project.displayName;
  const button = (
    <button
      ref={setNodeRef}
      type="button"
      aria-current={isCurrent}
      aria-label={label}
      data-drop={drop ?? undefined}
      data-rail={named ? "row" : "item"}
      data-dragging={isDragging || undefined}
      className={named ? ROW_CLASS : ITEM_CLASS}
      style={{ "--i": index } as CSSProperties}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(menuPosition(event));
      }}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
    >
      <span className={ICON_BOX_CLASS}>
        <ProjectFavicon project={project} className="size-full" />
      </span>
      {named ? (
        <>
          <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
          <StatusDots status={status} row />
        </>
      ) : (
        <StatusDots status={status} className="absolute end-0.5 top-1/2 -translate-y-1/2" />
      )}
    </button>
  );
  if (named) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

interface RailGroupProps {
  group: RailGroup;
  members: ReadonlyArray<SidebarProjectSnapshot>;
  memberStatuses: ReadonlyArray<ProjectRailStatus>;
  isCurrent: boolean;
  named: boolean;
  drop: DropPosition | null;
  dragActive: boolean;
  onToggle: () => void;
  onSelectGroup: () => void;
  onSelectProject: (projectKey: string) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  children: ReactNode;
}

function RailGroupBlock({
  group,
  members,
  memberStatuses,
  isCurrent,
  named,
  drop,
  dragActive,
  onToggle,
  onSelectGroup,
  onSelectProject,
  onContextMenu,
  children,
}: RailGroupProps) {
  const { setNodeRef, attributes, listeners, isDragging } = useRailDnd(`g:${group.id}`, false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const name = railGroupName(group);
  const status = combineProjectRailStatuses(memberStatuses);
  const summary = railGroupStatusSummary(memberStatuses);
  const headProps = {
    ref: setNodeRef,
    type: "button" as const,
    "aria-expanded": !group.collapsed,
    "aria-current": isCurrent,
    "data-rail-group-anchor": group.id,
    onClick: (event: React.MouseEvent) => {
      if (event.altKey) onSelectGroup();
      else onToggle();
    },
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(menuPosition(event));
    },
    ...attributes,
    ...listeners,
  };

  const head = named ? (
    <button
      {...headProps}
      aria-label={`${name}, ${summary}`}
      data-rail="gc-head"
      data-dragging={isDragging || undefined}
    >
      <ChevronDownIcon aria-hidden data-rail="chev" className="size-3.5" />
      <span data-rail="sw" />
      <span data-rail="nm">{name}</span>
      <span data-rail="stack" aria-hidden="true">
        {members.slice(0, 3).map((project) => (
          <span key={project.projectKey}>
            <ProjectFavicon project={project} className="size-full" />
          </span>
        ))}
      </span>
      <StatusDots status={status} row part="gc-dots" />
      <span data-rail="cnt">{members.length}</span>
    </button>
  ) : (
    <button
      {...headProps}
      aria-label={`${name}, ${summary}`}
      data-rail="ga-chip"
      data-dragging={isDragging || undefined}
    >
      <span data-rail="ga-name">{railGroupShortLabel(group.name)}</span>
      <span data-rail="ga-count">
        {members.length}
        <StatusDots status={status} row />
      </span>
    </button>
  );

  const shortHead = named ? (
    head
  ) : group.collapsed ? (
    <PreviewCard open={hoverOpen && !dragActive} onOpenChange={setHoverOpen}>
      <PreviewCardTrigger render={head} delay={280} closeDelay={120} />
      <PreviewCardPopup side="right" align="start" className="w-64">
        <div className="p-2">
          <div className="flex items-center gap-2 px-1.5 pb-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: railGroupSwatchHex(group.color) }}
            />
            <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
          </div>
          <p className="px-1.5 pb-1.5 text-xs text-muted-foreground">{summary}</p>
          <div className="flex flex-col">
            {members.map((project, index) => {
              const memberStatus = memberStatuses[index] ?? EMPTY_PROJECT_RAIL_STATUS;
              const statusText = projectRailStatusLabel(memberStatus);
              return (
                <button
                  key={project.projectKey}
                  type="button"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => {
                    setHoverOpen(false);
                    onSelectProject(project.projectKey);
                  }}
                >
                  <span className="grid size-4 shrink-0 place-items-center overflow-hidden">
                    <ProjectFavicon project={project} className="size-full" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
                  {statusText ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{statusText}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  ) : (
    <Tooltip>
      <TooltipTrigger render={head} />
      <TooltipPopup side="right">
        {name} · {summary}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      data-rail={named ? "gc" : "ga"}
      data-rail-group-color={group.color}
      data-collapsed={group.collapsed}
      data-drop={drop === "into" ? "into" : undefined}
    >
      {shortHead}
      <div data-rail="body">
        <div data-rail={named ? "gc-inner" : "ga-inner"} inert={group.collapsed}>
          {children}
        </div>
      </div>
    </div>
  );
}

function RailFooterButton({
  label,
  onClick,
  children,
  buttonRef,
  active = false,
  named = false,
  opensMenu = false,
}: {
  named?: boolean;
  opensMenu?: boolean;
  active?: boolean;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            aria-haspopup={opensMenu ? "menu" : undefined}
            className={named ? ROW_CLASS : ITEM_CLASS}
            onClick={onClick}
          >
            <span className={ICON_BOX_CLASS}>{children}</span>
            {named ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
          </button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

const railCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args).filter((collision) => collision.id !== "end");
  if (hits.length > 0) return hits;
  const pointerY = args.pointerCoordinates?.y;
  const visible = args.droppableContainers.filter((container) => {
    const rect = args.droppableRects.get(container.id);
    return container.id !== "end" && rect !== undefined && rect.height > 0;
  });
  const lastBottom = Math.max(
    ...visible.map((container) => args.droppableRects.get(container.id)?.bottom ?? 0),
  );
  if (pointerY !== undefined && pointerY > lastBottom) {
    return args.droppableContainers.some((container) => container.id === "end")
      ? [{ id: "end" }]
      : [];
  }
  return closestCenter({ ...args, droppableContainers: visible });
};

function RailEndDropZone() {
  const { setNodeRef } = useDroppable({ id: "end" });
  return <div ref={setNodeRef} aria-hidden="true" className="min-h-6 w-full flex-1" />;
}

/**
 * A column of project icons left of the sidebar, so switching project is one
 * click instead of opening the picker first. Desktop only: the mobile sidebar
 * is a sheet with no room beside it.
 *
 * The rail always uses the manual project order, whatever the sidebar's sort is
 * set to. Groups sit at their first member's place in that order, and every
 * rail move writes the order back, so the rail and the manual order never
 * disagree.
 */
export const ProjectRail = memo(function ProjectRail() {
  const isMobile = useIsMobile();
  const [visible, setVisible] = useProjectRailVisible();
  const [layout, setLayout] = useProjectRailLayout();
  const dragWidth = useProjectRailDragWidth((state) => state.width);
  const setDragWidth = useProjectRailDragWidth((state) => state.setWidth);
  const groupStyle = useClientSettings((settings) => settings.projectRailGroupStyle);
  const { projectGroups } = useSidebarProjectGroups({ sortOrder: "manual" });
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useThreadShells();
  const railGroups = useProjectRailGroupsStore((state) => state.groups);
  const setRailGroups = useProjectRailGroupsStore((state) => state.setGroups);
  const settledProjectKeys = useProjectRailGroupsStore((state) => state.settledProjectKeys);
  const setProjectSettled = useProjectRailGroupsStore((state) => state.setProjectSettled);
  const [persistedProjectScopeKey, setProjectScopeKey] = useSidebarProjectScope();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const lastVisitedByThread = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  // A short threshold, so a click still selects rather than starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const projectScopeKey = useMemo(
    () =>
      railGroupIdFromScopeKey(persistedProjectScopeKey) !== null
        ? persistedProjectScopeKey
        : resolveSidebarProjectScopeKey({
            groups: projectGroups,
            key: persistedProjectScopeKey,
            settings: projectGroupingSettings,
          }),
    [persistedProjectScopeKey, projectGroups, projectGroupingSettings],
  );
  const statuses = useMemo(
    () => projectRailStatuses(threads, lastVisitedByThread),
    [threads, lastVisitedByThread],
  );
  const snapshotByKey = useMemo(
    () => new Map(projectGroups.map((project) => [project.projectKey, project] as const)),
    [projectGroups],
  );
  const statusByKey = useMemo(
    () =>
      new Map(
        projectGroups.map(
          (project) =>
            [
              project.projectKey,
              combineProjectRailStatuses(
                project.memberProjects.map((member) =>
                  statuses.get(`${member.environmentId}:${member.id}`),
                ),
              ),
            ] as const,
        ),
      ),
    [projectGroups, statuses],
  );
  const fullEntries = useMemo(
    () =>
      buildRailLayout(
        projectGroups.map((project) => project.projectKey),
        railGroups,
      ),
    [projectGroups, railGroups],
  );
  const settledKeys = useMemo(() => new Set(settledProjectKeys), [settledProjectKeys]);
  const settledProjects = useMemo(
    () => projectGroups.filter((project) => settledKeys.has(project.projectKey)),
    [projectGroups, settledKeys],
  );
  const activeProjects = useMemo(
    () => projectGroups.filter((project) => !settledKeys.has(project.projectKey)),
    [projectGroups, settledKeys],
  );
  const entries = useMemo(
    () =>
      buildRailLayout(
        projectGroups.map((project) => project.projectKey),
        railGroups,
        settledKeys,
      ),
    [projectGroups, railGroups, settledKeys],
  );
  // Mutations retain settled members and their positions; only presentation is filtered.
  const model = useMemo(
    () => railModelFromLayout(fullEntries, railGroups),
    [fullEntries, railGroups],
  );
  const visibleModel = useMemo(
    () =>
      railModelFromLayout(
        entries,
        railGroups.map((group) => ({
          ...group,
          members: group.members.filter((key) => !settledKeys.has(key)),
        })),
      ),
    [entries, railGroups, settledKeys],
  );
  const environmentSections = useMemo(() => {
    const byKey = new Map<string, RailEnvironmentSection>();
    for (const environment of environmentIdentities) {
      byKey.set(environment.environmentId, {
        key: environment.environmentId,
        label:
          environment.environmentId === primaryEnvironmentId
            ? `${environment.label} · This Mac`
            : environment.label,
        machine: environmentMachines.get(environment.environmentId) ?? "server",
        entries: [],
      });
    }
    for (const entry of entries) {
      const environmentId = railEntryEnvironmentId(entry, snapshotByKey);
      const key = environmentId ?? "multiple-environments";
      const current = byKey.get(key) ?? {
        key,
        label: environmentId ? "Unknown environment" : "Multiple environments",
        machine: environmentId ? (environmentMachines.get(environmentId) ?? "server") : null,
        entries: [],
      };
      byKey.set(key, { ...current, entries: [...current.entries, entry] });
    }
    return [...byKey.values()].filter((section) => section.entries.length > 0);
  }, [entries, environmentIdentities, environmentMachines, primaryEnvironmentId, snapshotByKey]);

  if (isMobile || !visible || projectGroups.length === 0) return null;

  const width = resolveProjectRailWidth(layout, dragWidth);
  const named = dragWidth !== null ? dragWidth >= PROJECT_RAIL_SNAP_WIDTH : layout.named;
  const shownGroups = entries.flatMap((entry) => (entry.kind === "group" ? [entry.group] : []));
  const editingGroup = railGroups.find((group) => group.id === editingGroupId) ?? null;

  const commitGroups = (next: RailModel) => setRailGroups(next.groups);
  const commit = (next: RailModel) => {
    setRailGroups(next.groups);
    const flat = flattenRailModel(next, new Set(snapshotByKey.keys()));
    const physical = flat.flatMap(
      (key) =>
        snapshotByKey.get(key)?.memberProjects.map((member) => member.physicalProjectKey) ?? [],
    );
    const placed = new Set(physical);
    const rest = useUiStateStore.getState().projectOrder.filter((key) => !placed.has(key));
    useUiStateStore.setState({ projectOrder: [...physical, ...rest] });
  };

  const moveProject = (projectKey: string, direction: -1 | 1) => {
    const group = findRailGroupOf(visibleModel, projectKey);
    const items = group ? group.members : visibleModel.order;
    const token = group ? projectKey : `p:${projectKey}`;
    const target = items[items.indexOf(token) + direction];
    if (!target) return;
    commit(
      group
        ? placeRailProject(model, projectKey, target, direction > 0)
        : placeRailToken(model, token, target, direction > 0),
    );
  };
  const moveGroup = (groupId: string, direction: -1 | 1) => {
    const token = `g:${groupId}`;
    const target = visibleModel.order[visibleModel.order.indexOf(token) + direction];
    if (target) commit(placeRailToken(model, token, target, direction > 0));
  };

  const selectScope = (nextScopeKey: string | null) => {
    setProjectScopeKey(nextScopeKey);
    if (pathname.startsWith("/settings") || pathname === "/dashboard")
      void router.navigate({ to: "/" });
  };
  const setNamed = (nextNamed: boolean) =>
    setLayout((current) => ({ ...current, named: nextNamed }));

  const createGroupFrom = (
    projectKeys: ReadonlyArray<string>,
    name = "",
    color?: RailGroupColor,
  ) => {
    const id = newRailGroupId();
    commit(
      createRailGroup(model, projectKeys, {
        id,
        name,
        color: color ?? nextRailGroupColor(railGroups),
      }),
    );
    return id;
  };

  const showMenu = async (items: ContextMenuItem[], position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return null;
    try {
      return await api.contextMenu.show(items, position);
    } catch {
      return null;
    }
  };

  const openProjectMenu = async (projectKey: string, position: { x: number; y: number }) => {
    const project = snapshotByKey.get(projectKey);
    if (!project) return;
    const group = findRailGroupOf(model, projectKey);
    const clicked = await showMenu(
      buildRailProjectMenu({
        group,
        groups: shownGroups,
        canMoveUp: canMoveRailProject(visibleModel, projectKey, -1),
        canMoveDown: canMoveRailProject(visibleModel, projectKey, 1),
        hasPath: project.workspaceRoot.length > 0,
      }),
      position,
    );
    if (!clicked) return;
    if (clicked === "group:new") {
      setEditingGroupId(createGroupFrom([projectKey]));
      return;
    }
    if (clicked.startsWith("group:")) {
      commit(addToRailGroup(model, projectKey, clicked.slice("group:".length)));
      return;
    }
    switch (clicked) {
      case "open":
        selectScope(projectKey);
        return;
      case "group-scope":
        if (group) selectScope(railGroupScopeKey(group.id));
        return;
      case "remove-from-group":
        commit(removeFromRailGroup(model, projectKey));
        return;
      case "move-up":
      case "move-down":
        moveProject(projectKey, clicked === "move-up" ? -1 : 1);
        return;
      case "settle-project":
        setProjectSettled(projectKey, true);
        return;
      case "copy-path":
        try {
          await writeTextToClipboard(project.workspaceRoot, "path");
          toastManager.add({ type: "success", title: "Path copied" });
        } catch {
          toastManager.add({ type: "error", title: "Could not copy the path" });
        }
        return;
      case "project-settings":
        void router.navigate({
          to: "/projects/$projectKey",
          params: {
            projectKey: getSidebarProjectSettingsKey(project, projectGroupingSettings, projects),
          },
        });
        return;
    }
  };

  const openGroupMenu = async (group: RailGroup, position: { x: number; y: number }) => {
    const entry = entries.find(
      (candidate): candidate is Extract<RailEntry, { kind: "group" }> =>
        candidate.kind === "group" && candidate.group.id === group.id,
    );
    const memberStatuses = (entry?.members ?? []).map(
      (key) => statusByKey.get(key) ?? EMPTY_PROJECT_RAIL_STATUS,
    );
    const scopeKey = railGroupScopeKey(group.id);
    const clicked = await showMenu(
      buildRailGroupMenu({
        group,
        summary: railGroupStatusSummary(memberStatuses),
        isScoped: projectScopeKey === scopeKey,
        addableProjects: activeProjects
          .filter((project) => !group.members.includes(project.projectKey))
          .map((project) => ({ key: project.projectKey, label: project.displayName })),
        hasOtherGroups: shownGroups.length > 1,
        canMoveUp: canMoveRailGroup(visibleModel, group.id, -1),
        canMoveDown: canMoveRailGroup(visibleModel, group.id, 1),
      }),
      position,
    );
    if (!clicked) return;
    if (clicked.startsWith("color:")) {
      commitGroups(recolorRailGroup(model, group.id, clicked.slice(6) as RailGroupColor));
      return;
    }
    if (clicked.startsWith("add:")) {
      commit(addToRailGroup(model, clicked.slice(4), group.id));
      return;
    }
    switch (clicked) {
      case "toggle":
        commitGroups(setRailGroupCollapsed(model, group.id, !group.collapsed));
        return;
      case "scope":
        selectScope(projectScopeKey === scopeKey ? null : scopeKey);
        return;
      case "rename":
        setEditingGroupId(group.id);
        return;
      case "collapse-others":
        commitGroups(setAllRailGroupsCollapsed(model, true, group.id));
        return;
      case "move-up":
      case "move-down":
        moveGroup(group.id, clicked === "move-up" ? -1 : 1);
        return;
      case "ungroup":
        if (projectScopeKey === scopeKey) selectScope(null);
        commit(ungroupRailGroup(model, group.id));
        return;
    }
  };

  const openBackgroundMenu = async (position: { x: number; y: number }) => {
    const clicked = await showMenu(
      buildRailBackgroundMenu({ named, hasGroups: shownGroups.length > 0, settledProjects }),
      position,
    );
    if (clicked?.startsWith("open:")) {
      selectScope(clicked.slice("open:".length));
      return;
    }
    if (clicked?.startsWith("unsettle:")) {
      setProjectSettled(clicked.slice("unsettle:".length), false);
      return;
    }
    switch (clicked) {
      case "new-group":
        setNewGroupOpen(true);
        return;
      case "add-project":
        openCommandPalette({ open: "add-project" });
        return;
      case "expand-all":
      case "collapse-all":
        commitGroups(setAllRailGroupsCollapsed(model, clicked === "collapse-all"));
        return;
      case "toggle-names":
        setNamed(!named);
        return;
      case "hide-rail":
        setVisible(false);
        return;
    }
  };

  const pointerY = (event: DragMoveEvent | DragEndEvent) => {
    const activator = event.activatorEvent as PointerEvent | MouseEvent | null;
    return (activator?.clientY ?? 0) + event.delta.y;
  };
  const resolveDrop = (event: DragMoveEvent | DragEndEvent): DropTarget | null => {
    const { active, over } = event;
    if (!over) return null;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (overId === activeId) return null;
    if (overId === "end") return { id: "end", position: "after" };
    const y = pointerY(event);
    const after = y >= over.rect.top + over.rect.height / 2;
    if (activeId.startsWith("p:") && overId.startsWith("g:")) {
      return y < over.rect.top + over.rect.height / 4
        ? { id: overId, position: "before" }
        : { id: overId, position: "into" };
    }
    if (activeId.startsWith("g:") && overId.startsWith("p:")) {
      const dragged = model.groups.find((group) => `g:${group.id}` === activeId);
      if (dragged?.members.includes(overId.slice(2))) return null;
    }
    return { id: overId, position: after ? "after" : "before" };
  };
  const applyDrop = (activeId: string, target: DropTarget) => {
    if (target.id === "end") {
      commit(moveRailTokenToEnd(model, activeId));
      return;
    }
    const after = target.position === "after";
    if (activeId.startsWith("p:")) {
      const key = activeId.slice(2);
      if (target.id.startsWith("g:")) {
        commit(
          target.position === "into"
            ? addToRailGroup(model, key, target.id.slice(2))
            : placeRailToken(model, activeId, target.id, after),
        );
        return;
      }
      commit(placeRailProject(model, key, target.id.slice(2), after));
      return;
    }
    const targetToken = target.id.startsWith("g:")
      ? target.id
      : railTopTokenOf(model, target.id.slice(2));
    if (targetToken !== activeId) commit(placeRailToken(model, activeId, targetToken, after));
  };
  const handleDragStart = (event: DragStartEvent) => setActiveDragId(String(event.active.id));
  const handleDragMove = (event: DragMoveEvent) => {
    const next = resolveDrop(event);
    if (next?.id !== dropTarget?.id || next?.position !== dropTarget?.position) setDropTarget(next);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const target = resolveDrop(event);
    setActiveDragId(null);
    setDropTarget(null);
    if (target) applyDrop(String(event.active.id), target);
  };
  const handleDragCancel = () => {
    setActiveDragId(null);
    setDropTarget(null);
  };
  const dropFor = (id: string): DropPosition | null =>
    dropTarget?.id === id ? dropTarget.position : null;

  const finishResize = (finalWidth: number) => {
    setDragWidth(null);
    if (finalWidth < PROJECT_RAIL_SNAP_WIDTH) setNamed(false);
    else setLayout({ named: true, width: clampProjectRailNamedWidth(finalWidth) });
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!moved && Math.abs(delta) < 2) return;
      moved = true;
      latest = Math.round(
        Math.min(
          PROJECT_RAIL_MAX_NAMED_WIDTH,
          Math.max(PROJECT_RAIL_SHORT_WIDTH, startWidth + delta),
        ),
      );
      setDragWidth(latest);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (moved) finishResize(latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };
  const resizeByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setNamed(!named);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    if (!named) {
      if (direction > 0) setNamed(true);
      return;
    }
    if (direction < 0 && width <= PROJECT_RAIL_MIN_NAMED_WIDTH) setNamed(false);
    else
      setLayout({
        named: true,
        width: clampProjectRailNamedWidth(width + direction * RESIZE_STEP),
      });
  };

  const renderProject = (projectKey: string, index: number, inert: boolean) => {
    const project = snapshotByKey.get(projectKey);
    if (!project) return null;
    return (
      <RailProjectItem
        key={projectKey}
        project={project}
        status={statusByKey.get(projectKey) ?? EMPTY_PROJECT_RAIL_STATUS}
        isCurrent={projectScopeKey === projectKey}
        index={index}
        named={named}
        inert={inert}
        drop={dropFor(`p:${projectKey}`)}
        onSelect={() => selectScope(projectKey)}
        onContextMenu={(position) => void openProjectMenu(projectKey, position)}
        onMove={(direction) => moveProject(projectKey, direction)}
      />
    );
  };

  const activeProject =
    activeDragId?.startsWith("p:") === true ? snapshotByKey.get(activeDragId.slice(2)) : undefined;
  const activeGroup =
    activeDragId?.startsWith("g:") === true
      ? railGroups.find((group) => group.id === activeDragId.slice(2))
      : undefined;

  return (
    <nav
      aria-label="Projects"
      data-project-rail=""
      // Same token overrides the thread sidebar uses, so both columns share one
      // surface instead of the rail landing on the raised card colour.
      data-app-sidebar=""
      data-rail-root=""
      data-group-style={groupStyle}
      data-named={named}
      className={cn(
        "relative flex h-svh w-(--project-rail-width) shrink-0 flex-col gap-1 overflow-hidden border-e border-sidebar-border bg-sidebar pt-[var(--project-rail-top-inset,0.5rem)] pb-2 text-sidebar-foreground",
        named ? "items-stretch" : "items-center",
      )}
    >
      {named ? (
        <div className="px-1.5">
          <button
            type="button"
            className={ROW_CLASS}
            aria-current={pathname === "/dashboard" ? "page" : undefined}
            onClick={() => void router.navigate({ to: "/dashboard" })}
          >
            <span className={ICON_BOX_CLASS}>
              <LayoutDashboardIcon className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">Dashboard</span>
          </button>
        </div>
      ) : (
        <RailFooterButton
          label="Dashboard"
          active={pathname === "/dashboard"}
          onClick={() => void router.navigate({ to: "/dashboard" })}
        >
          <LayoutDashboardIcon className="size-4.5" />
        </RailFooterButton>
      )}
      {named ? (
        <div className="px-1.5">
          <button
            type="button"
            aria-current={projectScopeKey === null && pathname !== "/dashboard"}
            className={ROW_CLASS}
            onClick={() => selectScope(null)}
          >
            <span className={ICON_BOX_CLASS}>
              <LayersIcon className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">All projects</span>
          </button>
        </div>
      ) : (
        <RailFooterButton label="All projects" onClick={() => selectScope(null)}>
          <LayersIcon className="size-4.5" />
        </RailFooterButton>
      )}

      <div
        className={cn(
          "flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          named ? "items-stretch gap-px px-1.5" : "items-center gap-1",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          void openBackgroundMenu(menuPosition(event));
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={railCollisionDetection}
          modifiers={[restrictToVerticalAxis]}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {environmentSections.map((section) => (
            <div
              key={section.key}
              role="group"
              aria-label={`${section.label} projects`}
              className={cn("flex w-full flex-col", named ? "gap-px" : "items-center gap-1")}
            >
              <RailEnvironmentHeader
                label={section.label}
                machine={section.machine}
                named={named}
              />
              {section.entries.map((entry) => {
                if (entry.kind === "project") return renderProject(entry.key, 0, false);
                const { group } = entry;
                const members = entry.members.flatMap((key) => snapshotByKey.get(key) ?? []);
                return (
                  <RailGroupBlock
                    key={`g:${group.id}`}
                    group={group}
                    members={members}
                    memberStatuses={members.map(
                      (project) => statusByKey.get(project.projectKey) ?? EMPTY_PROJECT_RAIL_STATUS,
                    )}
                    isCurrent={projectScopeKey === railGroupScopeKey(group.id)}
                    named={named}
                    drop={dropFor(`g:${group.id}`)}
                    dragActive={activeDragId !== null}
                    onToggle={() =>
                      commitGroups(setRailGroupCollapsed(model, group.id, !group.collapsed))
                    }
                    onSelectGroup={() => selectScope(railGroupScopeKey(group.id))}
                    onSelectProject={(projectKey) => selectScope(projectKey)}
                    onContextMenu={(position) => void openGroupMenu(group, position)}
                  >
                    {entry.members.map((key, index) => renderProject(key, index, group.collapsed))}
                  </RailGroupBlock>
                );
              })}
            </div>
          ))}
          <RailEndDropZone />
          <DragOverlay dropAnimation={null}>
            {activeProject ? (
              <div className="grid size-9 place-items-center rounded-md border border-sidebar-border bg-sidebar-row-selected shadow-lg">
                <span className={ICON_BOX_CLASS}>
                  <ProjectFavicon project={activeProject} className="size-full" />
                </span>
              </div>
            ) : activeGroup ? (
              <div
                data-rail-group-color={activeGroup.color}
                data-rail="ga-chip"
                style={{ height: "auto", minHeight: "1.5rem" }}
              >
                <span data-rail="ga-name">{railGroupShortLabel(activeGroup.name)}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <div
        className={cn(
          "flex shrink-0 gap-1 border-t border-sidebar-border pt-1.5",
          named ? "px-1.5" : "items-center",
        )}
      >
        <RailFooterButton
          label="Project actions"
          buttonRef={actionsButtonRef}
          named={named}
          opensMenu
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void openBackgroundMenu({ x: rect.right + 4, y: rect.bottom });
          }}
        >
          <EllipsisIcon className="size-4.5" />
        </RailFooterButton>
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize project rail"
        aria-valuemin={PROJECT_RAIL_SHORT_WIDTH}
        aria-valuemax={PROJECT_RAIL_MAX_NAMED_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-rail="edge"
        data-resizing={dragWidth !== null}
        onPointerDown={startResize}
        onDoubleClick={() => setNamed(!named)}
        onKeyDown={resizeByKey}
      />

      <RailGroupEditorPopover
        group={editingGroup}
        anchor={() =>
          editingGroupId
            ? document.querySelector(`[data-rail-group-anchor="${editingGroupId}"]`)
            : null
        }
        onClose={() => setEditingGroupId(null)}
        onRename={(name) => {
          if (editingGroup) commitGroups(renameRailGroup(model, editingGroup.id, name));
        }}
        onRecolor={(color) => {
          if (editingGroup) commitGroups(recolorRailGroup(model, editingGroup.id, color));
        }}
        onUngroup={() => {
          if (!editingGroup) return;
          if (projectScopeKey === railGroupScopeKey(editingGroup.id)) selectScope(null);
          commit(ungroupRailGroup(model, editingGroup.id));
          setEditingGroupId(null);
        }}
      />
      <RailNewGroupPopover
        open={newGroupOpen}
        anchor={() => actionsButtonRef.current}
        projects={activeProjects}
        groupOf={(projectKey) => findRailGroupOf(model, projectKey)}
        initialColor={nextRailGroupColor(railGroups)}
        onClose={() => setNewGroupOpen(false)}
        onCreate={({ name, color, projectKeys }) => {
          createGroupFrom(projectKeys, name, color);
          setNewGroupOpen(false);
        }}
      />
    </nav>
  );
});
