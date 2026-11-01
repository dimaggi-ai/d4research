import { measureRestingComposerControls } from "./chat/restingComposerControlsMeasurement";
import { resolveRestingComposerControlsNaturalWidth } from "./composerFooterLayout";
import { cn } from "~/lib/utils";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { formatFilePathForClipboard } from "@d4research/client-runtime/media-actions";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { scopeProjectRef, scopeThreadRef } from "@d4research/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkspace,
  ProjectWorkspaceColor,
  ThreadId,
} from "@d4research/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  NotebookPenIcon,
  PlusIcon,
  ScaleIcon,
} from "lucide-react";
import {
  type Ref,
  type MouseEvent as ReactMouseEvent,
  memo,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useOpenDirectoryCommandPalette } from "../commandPaletteContext";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

import {
  PROJECT_WORKSPACE_COLORS,
  resolveWorkspaceColor,
  workspaceBadgeClassName,
  workspaceDisplayName,
} from "../lib/projectWorkspacePresentation";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type EnvMode,
  type EnvironmentOption,
  isExplicitWorkspaceModeSelectionReason,
  resolveContextStripLabelsCompact,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { type AddProjectTarget, useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { observeResize } from "~/lib/observeResize";

export interface BranchToolbarHandle {
  openBranchPicker: () => void;
  usePreviousWorktree: () => void;
}

interface BranchToolbarProps {
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarHandle>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  /** Allow changing the workspace mode after a server thread has started. */
  allowWorkspaceModeChange?: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  contextStripCollapsed?: boolean;
  onContextStripCollapsedChange?: (collapsed: boolean) => void;
  /** Reserved host used by the upstream compact-composer layout. */
  composerControlsHostRef?: (element: HTMLDivElement | null) => void;
  contextStripVisible?: boolean;
}

function WorkspaceBadge(props: {
  workspace: ProjectWorkspace;
  index: number;
  compact?: boolean;
  onColorChange: (color: ProjectWorkspaceColor) => void;
}) {
  const color = resolveWorkspaceColor(props.workspace, props.index);
  return (
    <Menu>
      <MenuTrigger
        className={workspaceBadgeClassName(
          color,
          `truncate rounded px-1.5 py-0.5 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${props.compact ? "max-w-20" : "max-w-32"}`,
        )}
        title={`${props.workspace.path} · Change directory color`}
      >
        {workspaceDisplayName(props.workspace, props.index)}
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-36">
        <MenuGroup>
          <MenuGroupLabel>Directory color</MenuGroupLabel>
          {PROJECT_WORKSPACE_COLORS.map((option) => (
            <MenuItem key={option.color} onClick={() => props.onColorChange(option.color)}>
              <span className={`size-2.5 rounded-full ${option.dotClassName}`} />
              <span>{option.label}</span>
              {option.color === color ? <CheckIcon className="ms-auto size-3.5" /> : null}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function AgentGuidanceButton(props: { workspace: ProjectWorkspace; onClick: () => void }) {
  const hasGuidance = Boolean(props.workspace.agentGuidance?.trim());
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={hasGuidance ? "text-primary" : "text-muted-foreground"}
            aria-label={`Edit agent guidance for ${props.workspace.label ?? props.workspace.path}`}
            onClick={props.onClick}
          />
        }
      >
        <NotebookPenIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {hasGuidance ? "Edit agent guidance" : "Add agent guidance"}
      </TooltipPopup>
    </Tooltip>
  );
}

function showWorkspaceContextMenu(event: ReactMouseEvent, workspacePath: string) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void api.contextMenu
    .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action !== "copy-path") return;
      const clipboardPath = formatFilePathForClipboard(workspacePath);
      void writeTextToClipboard(clipboardPath, "workspace path").then(
        (didCopy) => {
          if (didCopy) {
            toastManager.add({
              type: "success",
              title: "Path copied",
              description: clipboardPath,
            });
          }
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy path",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    });
}

interface RunContextSelectorProps {
  displayMode?: "toolbar" | "panel";
  workspaceRoot?: string;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

const RunContextSelector = memo(function RunContextSelector({
  displayMode = "toolbar",
  workspaceRoot,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
  addTargets,
  onAddToMachine,
}: RunContextSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envModeLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isPanel = displayMode === "panel";
  const isLocked = envLocked || (envModeLocked && (!isPanel || !showEnvironmentPicker));
  const workspacePath =
    forceNewWorktree || (effectiveEnvMode === "worktree" && !activeWorktreePath)
      ? null
      : (activeWorktreePath ?? workspaceRoot);
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (isPanel && workspacePath) {
      showWorkspaceContextMenu(event, workspacePath);
    }
  };
  const workspaceIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <WorkspaceIcon
          className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0 mx-0!"}
        />
      </TooltipTrigger>
      <TooltipPopup>
        {isPanel
          ? forceNewWorktree
            ? "Each model starts in its own worktree."
            : (workspacePath ?? workspaceLabel)
          : workspaceLabel}
      </TooltipPopup>
    </Tooltip>
  );
  const environmentIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {autoEnvironmentLabel ? (
          <ScaleIcon
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0 mx-0!"}
            aria-hidden="true"
          />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            // Wide machine glyphs need a little more box to match the square row icons.
            className={
              isPanel
                ? cn(THREAD_DETAILS_PANEL_ICON_CLASS, "-mx-px size-4.5")
                : "size-3 shrink-0 mx-0!"
            }
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
    </Tooltip>
  );
  const icon = !showEnvironmentIndicator ? (
    workspaceIcon
  ) : isPanel ? (
    environmentIcon
  ) : (
    // Button's SVG margins consume 4px of the gap; mx-0! restores the intended 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {environmentIcon}
      {workspaceIcon}
    </span>
  );
  const triggerContent = (
    <>
      {icon}
      <ComposerContextLabel displayMode={displayMode}>
        {autoEnvironmentLabel ??
          (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}
      </ComposerContextLabel>
      {/* Trailing in the panel, so every row label starts on the same edge. */}
      {isPanel && showEnvironmentIndicator ? workspaceIcon : null}
    </>
  );

  if (isLocked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 font-normal text-foreground/70 text-xs sm:h-6 dark:text-muted-foreground",
          isPanel && "max-w-full",
          isPanel && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        onContextMenu={handleContextMenu}
        aria-label={isPanel ? "Run context" : undefined}
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl part="select" /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 max-w-[48%] flex-initial justify-start"}
        onContextMenu={handleContextMenu}
        onMouseDownCapture={
          isPanel
            ? (event) => {
                if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
              }
            : undefined
        }
        aria-label={isPanel ? "Run context" : undefined}
        data-composer-context-control
        data-composer-shortcut={[
          showEnvironmentPicker && !envLocked ? "composer.host" : "",
          !envModeLocked ? "composer.workspace" : "",
        ].join(" ")}
      >
        {triggerContent}
        {!isPanel ? <ChevronDownIcon className="size-3 shrink-0 mx-0!" /> : null}
      </MenuTrigger>
      <MenuPopup
        align="start"
        side={isPanel ? "bottom" : "top"}
        className={
          isPanel
            ? "w-(--anchor-width)"
            : previousWorktreeLabel
              ? "w-[min(21rem,calc(100vw-2rem))]"
              : undefined
        }
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        {availableEnvironments &&
        ((showEnvironmentPicker && onEnvironmentChange) || addTargets.length > 0) ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange?.(value as EnvironmentId)
                }
              >
                {onAutoEnvironment && (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment?.();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ScaleIcon className="size-3" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {autoEnvironmentLabel ?? "Auto balance"}
                      </span>
                    </span>
                  </MenuRadioItem>
                )}
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={
                      envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                    }
                    value={env.environmentId}
                    closeOnClick
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {addTargets.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                      <PlusIcon className="size-3" />
                      <span className="min-w-0 truncate">Add to another machine</span>
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup {...(!isPanel ? composerFloatingLayerProps : {})}>
                    {addTargets.map((target) => (
                      <MenuItem
                        key={target.environmentId}
                        onClick={() => onAddToMachine(target.environmentId)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                          <span className="min-w-0 truncate">{target.label}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value, eventDetails) => {
              if (!isExplicitWorkspaceModeSelectionReason(eventDetails.reason)) return;
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";

/** A hidden or squeezed label's scrollWidth loses its tail, causing label/icon flapping. */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

function animateLabelWidths(
  previousRects: ReadonlyMap<HTMLElement, DOMRect>,
  animations: Map<HTMLElement, Animation>,
) {
  for (const animation of animations.values()) animation.cancel();
  animations.clear();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const [label, previousRect] of previousRects) {
    if (!label.isConnected) continue;
    const nextWidth = label.getBoundingClientRect().width;
    if (Math.abs(previousRect.width - nextWidth) < 0.5) continue;

    const animation = label.animate(
      [
        { width: `${previousRect.width}px`, maxWidth: `${previousRect.width}px` },
        { width: `${nextWidth}px`, maxWidth: `${nextWidth}px` },
      ],
      {
        duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
        easing: COMPOSER_CONTEXT_MOTION_EASING,
        fill: "backwards",
      },
    );
    animations.set(label, animation);
    animation.addEventListener(
      "finish",
      () => {
        if (animations.get(label) === animation) animations.delete(label);
      },
      { once: true },
    );
  }
}

/**
 * Whether the strip's labels must collapse to icons. The strip is measured when
 * it, a control group or a hosted control resizes, when its text or children
 * change, and when fonts load, which covers everything the widths depend on.
 */
function useLabelsOverflow(): readonly [
  attach: (element: HTMLDivElement | null) => (() => void) | undefined,
  overflows: boolean,
] {
  const [overflows, setOverflows] = useState(false);

  const attach = (current: HTMLDivElement | null) => {
    if (!current) return;
    const labelAnimations = new Map<HTMLElement, Animation>();

    const measure = () => {
      // The committed attribute, not render state, so a stale closure cannot misread it.
      const compact = current.hasAttribute("data-compact");
      const stripWidth = current.clientWidth;
      if (stripWidth === 0) return;
      const stripStyle = getComputedStyle(current);
      const available =
        stripWidth -
        (Number.parseFloat(stripStyle.paddingInlineStart) || 0) -
        (Number.parseFloat(stripStyle.paddingInlineEnd) || 0);
      const contentWidth = (parent: Element): number => {
        const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
        let width = 0;
        let counted = 0;
        for (const child of parent.children) {
          if (!(child instanceof HTMLElement)) continue;
          if (child.offsetWidth === 0) continue;
          const style = getComputedStyle(child);
          const position = style.position;
          if (position === "absolute" || position === "fixed") continue;
          width +=
            child.offsetWidth +
            (Number.parseFloat(style.marginInlineStart) || 0) +
            (Number.parseFloat(style.marginInlineEnd) || 0);
          counted += 1;
        }
        return width + gap * Math.max(0, counted - 1);
      };
      const stripGap = Number.parseFloat(stripStyle.columnGap) || 0;
      let needed = 0;
      let groups = 0;
      for (const child of current.children) {
        if (!(child instanceof HTMLElement)) continue;
        // Reserve overflowed controls' width to prevent repeated hiding and expansion.
        const hostedControls = child.matches('[data-chat-resting-composer-controls-host="true"]')
          ? child.querySelector<HTMLElement>('[data-chat-composer-resting-controls="true"]')
          : null;
        const hostedMeasurement = hostedControls
          ? measureRestingComposerControls(hostedControls)
          : null;
        const width = hostedMeasurement
          ? resolveRestingComposerControlsNaturalWidth(hostedMeasurement)
          : contentWidth(hostedControls ?? child);
        if (width <= 1) continue;
        needed += width;
        groups += 1;
      }
      needed += stripGap * Math.max(0, groups - 1);
      const range = document.createRange();
      for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
        needed += Math.max(0, labelTextWidth(label, range) - label.getBoundingClientRect().width);
      }
      const nextOverflows = resolveContextStripLabelsCompact({
        compact,
        neededWidth: needed,
        availableWidth: available,
      });
      if (nextOverflows === compact) return;
      const previousRects = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)).map(
          (label) => [label, label.getBoundingClientRect()] as const,
        ),
      );
      flushSync(() => setOverflows(nextOverflows));
      animateLabelWidths(previousRects, labelAnimations);
    };

    let stopResize = () => {};
    const observeSizes = () => {
      stopResize();
      stopResize = observeResize(
        [
          current,
          ...Array.from(current.children),
          ...Array.from(current.querySelectorAll("[data-chat-composer-resting-controls='true']")),
          ...Array.from(current.querySelectorAll(COMPOSER_CONTEXT_LABEL_SELECTOR)),
        ],
        measure,
      );
    };
    observeSizes();
    // Text and control changes alter natural widths without resizing a hidden
    // or squeezed label, so they re-measure too. Only added or removed elements
    // can change the observed set; re-subscribing delivers a measure itself.
    const mutations = new MutationObserver((records) => {
      const elementsChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      );
      if (elementsChanged) observeSizes();
      else measure();
    });
    mutations.observe(current, { childList: true, characterData: true, subtree: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopResize();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
      for (const animation of labelAnimations.values()) animation.cancel();
    };
  };

  return [attach, overflows] as const;
}

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  forceNewWorktree = false,
  ref,
  environmentId,
  threadId,
  projectId,
  worktreePath,
  isServerThread,
  showGitControls,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  allowWorkspaceModeChange = false,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  contextStripCollapsed = false,
  onContextStripCollapsedChange = () => {},
  composerControlsHostRef,
}: BranchToolbarProps) {
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  const composerFloatingLayerProps = useComposerMenuProps();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // The composer retains resolved thread details while bootstrap cleanup can remove its shell.
  const activeProjectRef = scopeProjectRef(environmentId, projectId);
  const activeProject = useProject(activeProjectRef);
  const isMobile = useIsMobile();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const activeWorktreePath = forceNewWorktree ? null : worktreePath;
  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  const envModeLocked =
    !allowWorkspaceModeChange && (envLocked || (isServerThread && activeWorktreePath !== null));

  const canUsePreviousWorktree = !isServerThread && !envModeLocked && !forceNewWorktree;
  const projectRefsForWorktreeLookup = canUsePreviousWorktree ? [activeProjectRef] : [];
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = canUsePreviousWorktree
    ? resolvePreviousWorktreeSeed({
        threads: projectThreads,
        currentWorktreePath: activeWorktreePath,
      })
    : null;
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = () => {
    if (!previousWorktreeSeed) return;
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      openBranchPicker: () => branchSelectorRef.current?.open(),
      usePreviousWorktree: () => {
        if (!showGitControls || !canUsePreviousWorktree || !previousWorktreeSeed) return;
        onUsePreviousWorktree();
        onComposerFocusRequest?.();
      },
    }),
    [
      canUsePreviousWorktree,
      onComposerFocusRequest,
      onUsePreviousWorktree,
      previousWorktreeSeed,
      showGitControls,
    ],
  );

  const addTargets = useAddProjectTargets(activeProject, availableEnvironments);
  const onAddToMachine = (targetEnvironmentId: EnvironmentId | null) =>
    openAddProjectToMachine({ projectRef: activeProjectRef, targetEnvironmentId });
  // A project on one machine still gets the picker when it can be added to another.
  const hasMultipleEnvironments = (availableEnvironments?.length ?? 0) > 1 || addTargets.length > 0;
  const showEnvironmentPicker = hasMultipleEnvironments && onEnvironmentChange !== undefined;
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  // Started threads get no handler but still show which machine they run on,
  // matching the strip visibility ChatView computes from the same inputs.
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });
  const [attachStrip, labelsOverflow] = useLabelsOverflow();
  const workspaceRoots: ReadonlyArray<ProjectWorkspace> = activeProject?.workspaceRoots?.length
    ? activeProject.workspaceRoots
    : activeProject
      ? [{ path: activeProject.workspaceRoot, label: "Primary directory" }]
      : [];
  const canCollapseContextStrip = !isMobile && showGitControls && workspaceRoots.length > 1;
  const isContextStripCollapsed =
    (isMobile && showGitControls && workspaceRoots.length > 1) ||
    (canCollapseContextStrip && contextStripCollapsed);
  const openDirectoryPicker = useOpenDirectoryCommandPalette();
  const reportWorkspaceRootFailure = (result: Awaited<ReturnType<typeof updateProject>>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to update project directories",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const persistWorkspaceRoots = async (nextRoots: ReadonlyArray<ProjectWorkspace>) => {
    if (!activeProject) return;
    const result = await updateProject({
      environmentId: activeProject.environmentId,
      input: { projectId: activeProject.id, workspaceRoots: nextRoots },
    });
    reportWorkspaceRootFailure(result);
  };
  const addWorkspaceRoot = () => {
    if (!activeProject) return;
    openDirectoryPicker({
      environmentId: activeProject.environmentId,
      initialPath: activeProject.workspaceRoot,
      onSelect: async (selectedPath) => {
        const normalizedPath = selectedPath.replace(/[\\/]+$/, "") || selectedPath;
        if (workspaceRoots.some((root) => root.path === normalizedPath)) {
          toastManager.add({ type: "warning", title: "Directory is already in this project" });
          return;
        }
        await persistWorkspaceRoots([...workspaceRoots, { path: normalizedPath }]);
      },
    });
  };
  const setWorkspaceRootMode = (path: string, mode: EnvMode) => {
    void persistWorkspaceRoots(
      workspaceRoots.map((root) =>
        root.path === path ? { ...root, defaultThreadEnvMode: mode } : root,
      ),
    );
  };
  const setWorkspaceRootColor = (path: string, color: ProjectWorkspaceColor) => {
    void persistWorkspaceRoots(
      workspaceRoots.map((root) => (root.path === path ? { ...root, color } : root)),
    );
  };
  const [guidanceWorkspacePath, setGuidanceWorkspacePath] = useState<string | null>(null);
  const guidanceWorkspace =
    workspaceRoots.find((root) => root.path === guidanceWorkspacePath) ?? null;
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const openAgentGuidance = (workspace: ProjectWorkspace) => {
    setGuidanceWorkspacePath(workspace.path);
    setGuidanceDraft(workspace.agentGuidance ?? "");
  };
  const saveAgentGuidance = async () => {
    if (!guidanceWorkspace) return;
    const guidance = guidanceDraft.trim();
    await persistWorkspaceRoots(
      workspaceRoots.map((root) =>
        root.path === guidanceWorkspace.path
          ? {
              ...root,
              ...(guidance ? { agentGuidance: guidance } : { agentGuidance: undefined }),
            }
          : root,
      ),
    );
    setGuidanceWorkspacePath(null);
  };

  const addWorkspaceRootButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Add directory to project"
            onClick={addWorkspaceRoot}
          />
        }
      >
        <PlusIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Add directory to project</TooltipPopup>
    </Tooltip>
  );

  const expandContextStrip = () => {
    if (isMobile) return;
    onContextStripCollapsedChange(false);
  };

  const useDirectoryChips = showGitControls && workspaceRoots.length > 1;
  const showCompactStrip = isContextStripCollapsed || useDirectoryChips;
  const compactContextStrip = showCompactStrip ? (
    <div
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 overflow-x-auto overflow-y-hidden py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button,[role='button']")) {
          return;
        }
        if (!useDirectoryChips) expandContextStrip();
      }}
    >
      {addWorkspaceRootButton}
      {showEnvironmentIndicator && availableEnvironments ? (
        <BranchToolbarEnvironmentSelector
          compact
          envLocked={envLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          {...(showEnvironmentPicker ? { onEnvironmentChange } : {})}
          {...(addTargets.length > 0 ? { onAddToMachine: () => onAddToMachine(null) } : {})}
        />
      ) : null}
      {workspaceRoots.map((root, rootIndex) => {
        const isPrimary = rootIndex === 0;
        const controls = (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <WorkspaceBadge
              workspace={root}
              index={rootIndex}
              compact
              onColorChange={(color) => setWorkspaceRootColor(root.path, color)}
            />
            <BranchToolbarEnvModeSelector
              compact
              envLocked={isPrimary ? envModeLocked : false}
              effectiveEnvMode={
                isPrimary ? effectiveEnvMode : (root.defaultThreadEnvMode ?? "local")
              }
              activeWorktreePath={isPrimary ? activeWorktreePath : null}
              onEnvModeChange={(mode) =>
                isPrimary ? onEnvModeChange(mode) : setWorkspaceRootMode(root.path, mode)
              }
              {...(isPrimary
                ? {
                    previousWorktreeLabel,
                    onUsePreviousWorktree,
                  }
                : {})}
            />
            <AgentGuidanceButton workspace={root} onClick={() => openAgentGuidance(root)} />
            <BranchToolbarBranchSelector
              ref={branchSelectorRef}
              compact
              forceNewWorktree={isPrimary && forceNewWorktree}
              className="min-w-0 max-w-36"
              environmentId={environmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={isPrimary ? envLocked : false}
              allowWorkspaceModeChange={isPrimary ? allowWorkspaceModeChange : false}
              effectiveEnvModeOverride={
                isPrimary ? envMode : (root.defaultThreadEnvMode ?? envMode)
              }
              {...(isPrimary && activeThreadBranchOverride !== undefined
                ? { activeThreadBranchOverride }
                : {})}
              {...(isPrimary && onActiveThreadBranchOverrideChange
                ? { onActiveThreadBranchOverrideChange }
                : {})}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={onStartFromOriginChange}
              {...(isPrimary && onCheckoutPullRequestRequest
                ? { onCheckoutPullRequestRequest }
                : {})}
              {...(isPrimary ? {} : { workspaceRootOverride: root.path })}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          </div>
        );
        return useDirectoryChips ? (
          <Popover key={root.path}>
            <PopoverTrigger
              data-composer-context-control="true"
              className={workspaceBadgeClassName(
                resolveWorkspaceColor(root, rootIndex),
                "flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
              aria-label={`Directory controls for ${workspaceDisplayName(root, rootIndex)}`}
              title={root.path}
            >
              <FolderIcon className="size-3 shrink-0 opacity-70" />
              <span className="truncate">{workspaceDisplayName(root, rootIndex)}</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              side="top"
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
            >
              <div className="space-y-1">
                <PopoverTitle className="text-xs">
                  {workspaceDisplayName(root, rootIndex)}
                  {isPrimary ? (
                    <span className="ms-2 font-normal text-muted-foreground">Primary</span>
                  ) : null}
                </PopoverTitle>
                <p className="break-all font-mono text-[10px] text-muted-foreground">{root.path}</p>
              </div>
              {controls}
            </PopoverPopup>
          </Popover>
        ) : (
          <div key={root.path} className="shrink-0">
            {controls}
          </div>
        );
      })}
      {!useDirectoryChips ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="ms-auto shrink-0 max-md:hidden"
                aria-label="Expand project context"
                onClick={expandContextStrip}
              />
            }
          >
            <ChevronDownIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Expand project context</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  ) : null;

  const collapseContextStripButton = canCollapseContextStrip ? (
    <div className="pointer-events-none absolute end-0 bottom-1 start-1 z-20 flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pointer-events-auto bg-background/45 text-muted-foreground/70 shadow-xs hover:bg-background/75 hover:text-foreground"
              aria-label="Collapse project context"
              onClick={() => onContextStripCollapsedChange(true)}
            />
          }
        >
          <ChevronUpIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Collapse project context</TooltipPopup>
      </Tooltip>
    </div>
  ) : null;

  if (!activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {panelSection !== "branch" ? (
          <RunContextSelector
            displayMode="panel"
            workspaceRoot={activeProject.workspaceRoot}
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={activeEnvironmentOption !== null}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        ) : null}
        {panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={envLocked}
            effectiveEnvModeOverride={effectiveEnvMode}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            startFromOrigin={startFromOrigin}
            onStartFromOriginChange={onStartFromOriginChange}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={attachStrip}
      data-compact={!showCompactStrip && labelsOverflow ? "" : undefined}
      data-collapsed={showCompactStrip ? "true" : undefined}
      className="chat-composer-context-strip group/composer-context -mt-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-2 overflow-x-clip overflow-y-visible ps-1 pe-2 pt-5 pb-1"
    >
      {compactContextStrip}
      {!showCompactStrip && isMobile && showGitControls ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {addWorkspaceRootButton}
          <RunContextSelector
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={showEnvironmentIndicator}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        </div>
      ) : !showCompactStrip ? (
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <div className="flex min-w-0 max-w-full items-center gap-1">
            {showGitControls ? addWorkspaceRootButton : null}
            {showGitControls && workspaceRoots.length > 1 ? (
              workspaceRoots[0] ? (
                <WorkspaceBadge
                  workspace={workspaceRoots[0]}
                  index={0}
                  onColorChange={(color) => setWorkspaceRootColor(workspaceRoots[0]!.path, color)}
                />
              ) : null
            ) : null}
            {showEnvironmentIndicator && availableEnvironments && (
              <>
                <BranchToolbarEnvironmentSelector
                  envLocked={envLocked}
                  environmentId={environmentId}
                  availableEnvironments={availableEnvironments}
                  {...(showEnvironmentPicker ? { onEnvironmentChange } : {})}
                  {...(addTargets.length > 0 ? { onAddToMachine: () => onAddToMachine(null) } : {})}
                />
                {showGitControls ? (
                  <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
                ) : null}
              </>
            )}
            {showGitControls ? (
              <BranchToolbarEnvModeSelector
                envLocked={envModeLocked}
                forceNewWorktree={forceNewWorktree}
                effectiveEnvMode={effectiveEnvMode}
                activeWorktreePath={activeWorktreePath}
                onEnvModeChange={onEnvModeChange}
                previousWorktreeLabel={previousWorktreeLabel}
                onUsePreviousWorktree={onUsePreviousWorktree}
              />
            ) : null}
          </div>
          {showGitControls
            ? workspaceRoots.slice(1).map((root, rootIndex) => (
                <div key={root.path} className="flex min-w-0 max-w-full items-center gap-1">
                  <span aria-hidden="true" className="size-6 shrink-0" />
                  <WorkspaceBadge
                    workspace={root}
                    index={rootIndex + 1}
                    onColorChange={(color) => setWorkspaceRootColor(root.path, color)}
                  />
                  <BranchToolbarEnvModeSelector
                    envLocked={false}
                    effectiveEnvMode={root.defaultThreadEnvMode ?? "local"}
                    activeWorktreePath={null}
                    onEnvModeChange={(mode) => setWorkspaceRootMode(root.path, mode)}
                  />
                </div>
              ))
            : null}
        </div>
      ) : null}

      {!showCompactStrip && showGitControls ? (
        <div className="flex min-w-0 flex-1 flex-col items-end gap-0.5 md:ml-auto md:flex-none">
          <div className="flex min-w-0 max-w-full items-center gap-1">
            {workspaceRoots[0] ? (
              <AgentGuidanceButton
                workspace={workspaceRoots[0]}
                onClick={() => openAgentGuidance(workspaceRoots[0]!)}
              />
            ) : null}
            <BranchToolbarBranchSelector
              ref={branchSelectorRef}
              className="min-w-0 flex-1 justify-end"
              forceNewWorktree={forceNewWorktree}
              environmentId={environmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={envLocked}
              allowWorkspaceModeChange={allowWorkspaceModeChange}
              effectiveEnvModeOverride={envMode}
              {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
              {...(onActiveThreadBranchOverrideChange
                ? { onActiveThreadBranchOverrideChange }
                : {})}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={onStartFromOriginChange}
              {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          </div>
          {workspaceRoots.slice(1).map((root, rootIndex) => (
            <div key={root.path} className="flex min-w-0 max-w-full items-center gap-1">
              {isMobile ? (
                <span className="max-w-24 truncate text-[10px] text-muted-foreground/60">
                  {workspaceDisplayName(root, rootIndex + 1)}
                </span>
              ) : null}
              <AgentGuidanceButton workspace={root} onClick={() => openAgentGuidance(root)} />
              <BranchToolbarBranchSelector
                className="min-w-0 flex-1 justify-end"
                environmentId={environmentId}
                threadId={threadId}
                {...(draftId ? { draftId } : {})}
                envLocked={false}
                allowWorkspaceModeChange={false}
                effectiveEnvModeOverride={root.defaultThreadEnvMode ?? envMode}
                workspaceRootOverride={root.path}
                startFromOrigin={startFromOrigin}
                onStartFromOriginChange={onStartFromOriginChange}
                {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
              />
            </div>
          ))}
        </div>
      ) : null}
      {composerControlsHostRef ? (
        <div
          ref={composerControlsHostRef}
          data-composer-context-control
          data-chat-resting-composer-controls-host="true"
          className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
        />
      ) : null}
      {!showCompactStrip ? collapseContextStripButton : null}
      <Dialog
        open={guidanceWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) setGuidanceWorkspacePath(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent guidance</DialogTitle>
            <DialogDescription>
              Private instructions sent with every agent turn for this directory. They are not shown
              in the chat transcript.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-2">
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {guidanceWorkspace?.path}
              </p>
              <Textarea
                value={guidanceDraft}
                maxLength={8000}
                placeholder="Example: Commit directly to main after each completed change. Do not create a branch."
                onChange={(event) => setGuidanceDraft(event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                {guidanceDraft.length.toLocaleString()} / 8,000 characters
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGuidanceWorkspacePath(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveAgentGuidance()}>
              Save guidance
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
