import { isTestChangedFile } from "@d4research/shared/changedFileKind";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import { toolCallDiff } from "../lib/toolCallDiff";
import type { ReviewDiffPreviewInput } from "@d4research/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@d4research/client-runtime/errors";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@d4research/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  FolderGit2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { workspaceDisplayName } from "~/lib/projectWorkspacePresentation";
import type { DiffTreeFile } from "~/lib/turnDiffTree";
import { cn } from "~/lib/utils";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useRenderedAppearance } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffFilesTreeNavigator } from "./diffs/DiffFilesTreeNavigator";
import { ResizableColumns } from "./ui/resizable-columns";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";
import { useProjectEntriesWatchRefresh } from "./files/projectFilesQueryState";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { projectCommitUrl } from "@d4research/client-runtime/change-request-links";
import { useOpenLink } from "../browser/useOpenLink";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon className="size-4" icon={collapsed ? ChevronRight : ChevronDown} />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}

function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  workspaceMutationId,
  visible,
}: DiffPanelProps) {
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings();
  const diffLayout = settings.diffLayout;
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  // The open commit menu keeps the list it opened with, so rows do not move under the pointer.
  const [openCommitMenu, setOpenCommitMenu] = useState<ReviewBranchCommitsResult | null>(null);
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const [filesTreeOpen, setFilesTreeOpen] = useState(true);
  const [treeSelectedFilePath, setTreeSelectedFilePath] = useState<string | null>(null);
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);

  const routeThreadRef = useThreadRouteRef();
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
  const { canReadFiles } = fileAccess;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const primaryCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const diffRoots = useMemo(() => {
    if (!primaryCwd) return [];
    const configuredRoots = activeProject?.workspaceRoots?.length
      ? activeProject.workspaceRoots
      : [{ path: activeProject?.workspaceRoot ?? primaryCwd, label: "Primary directory" }];
    return [
      { ...configuredRoots[0], path: primaryCwd },
      ...configuredRoots.slice(1).filter((root) => root.path !== primaryCwd),
    ];
  }, [activeProject?.workspaceRoot, activeProject?.workspaceRoots, primaryCwd]);
  const [selectedWorkspaceRoot, setSelectedWorkspaceRoot] = useState<string | null>(null);
  const selectedGitCwd =
    selectedWorkspaceRoot && diffRoots.some((root) => root.path === selectedWorkspaceRoot)
      ? selectedWorkspaceRoot
      : primaryCwd;
  const selectedDiffRootIndex = diffRoots.findIndex((root) => root.path === selectedGitCwd);
  const selectedDiffRoot = diffRoots[selectedDiffRootIndex];
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const toolCallSelection = diffSelection.kind === "tool-call" ? diffSelection : null;
  const isGitSelection =
    diffSelection.kind === "branch" ||
    diffSelection.kind === "unstaged" ||
    diffSelection.kind === "commit";
  const toolCallItems = useQuietThreadVisibleTurnItems(toolCallSelection ? routeThreadRef : null);
  const toolCallDetail = useTurnItemDetail(
    toolCallSelection && routeThreadRef
      ? {
          ...resolveToolCallDiffTarget(toolCallSelection, toolCallItems),
          environmentId: routeThreadRef.environmentId,
        }
      : null,
  );
  const toolCallItem = toolCallDetail.data?.item;
  const toolCallPreview =
    toolCallSelection && toolCallItem?.type === "file_change" ? toolCallDiff(toolCallItem) : null;
  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const activeCwd = selectedTurnId === null ? selectedGitCwd : primaryCwd;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const rememberedBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, routeThreadRef),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadRef);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount = left.checkpointTurnCount;
        const rightTurnCount = right.checkpointTurnCount;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [turnDiffSummaries],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconcile persisted turn selection with streamed checkpoint availability.
  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope =
    diffSelection.kind === "unstaged" || diffSelection.kind === "commit"
      ? diffSelection.kind
      : "branch";
  const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.sha : null;
  const selectedBaseRef =
    diffSelection.kind === "branch" || diffSelection.kind === "commit"
      ? diffSelection.baseRef
      : null;
  const activeSourceKind =
    selectedGitScope === "unstaged"
      ? "working-tree"
      : selectedGitScope === "commit"
        ? "commit"
        : "branch-range";
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
        orderedTurnDiffSummaries[0]);
  const isRecordedSelection = selectedTurn !== undefined || toolCallSelection !== null;
  const selectedCheckpointTurnCount = selectedTurn?.checkpointTurnCount;
  const latestTurn = orderedTurnDiffSummaries[0];
  const reviewSectionId = toolCallSelection
    ? `tool:${toolCallSelection.threadId}:${toolCallSelection.itemId}:${toolCallSelection.revision}`
    : selectedTurn
      ? `turn:${selectedTurn.runId}`
      : selectedCommitSha !== null
        ? `commit:${selectedCommitSha}`
        : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${activeCwd ?? "none"}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const branchDiffPreviewInput: ReviewDiffPreviewInput | undefined =
    canReadFiles && isGitSelection && activeThread && activeCwd
      ? {
          cwd: activeCwd,
          ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
          ...(selectedCommitSha !== null ? { commitSha: selectedCommitSha } : {}),
          ignoreWhitespace: diffIgnoreWhitespace,
          sourceKind: activeSourceKind,
          includePatch: false,
        }
      : undefined;
  const branchDiffPreview = useEnvironmentQuery(
    branchDiffPreviewInput && activeThread
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: branchDiffPreviewInput,
        })
      : null,
  );
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  // The refreshers below run from listeners that must not re-register on every query identity.
  const refreshDiffRef = useRef<() => void>(() => {});
  const canRefreshGitDiff =
    isGitRepo && isGitSelection && activeThread != null && activeCwd != null;
  const branchCommitsQuery = useEnvironmentQuery(
    visible && isGitRepo && canReadFiles && activeThread && activeCwd
      ? reviewEnvironment.branchCommits({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(rememberedBaseRef ? { baseRef: rememberedBaseRef } : {}),
          },
        })
      : null,
  );
  const branchCommits = openCommitMenu ?? branchCommitsQuery.data;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the window focus listener for the selected repository diff.
  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshDiffRef.current();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff]);
  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) =>
      source.kind ===
      (selectedGitScope === "unstaged"
        ? "working-tree"
        : selectedGitScope === "commit"
          ? "commit"
          : "branch-range"),
  );
  const comparisonHeadRef = selectedGitSource?.headRef ?? gitStatusQuery.data?.refName ?? "HEAD";
  const comparisonBaseRef = selectedGitSource?.baseRef ?? selectedBaseRef ?? "Automatic";
  const selectedCommitSubject =
    selectedCommitSha !== null && selectedGitSource?.headRef === selectedCommitSha
      ? selectedGitSource.commitSubject
      : undefined;
  const selectedGitScopeLabel =
    selectedCommitSha !== null
      ? (selectedCommitSubject ?? `Commit ${selectedCommitSha.slice(0, 7)}`)
      : selectedGitScope === "unstaged"
        ? "Uncommitted"
        : "Changes";
  const selectedScopeLabel = toolCallSelection
    ? "Tool call"
    : selectedRunId === null
      ? selectedCommitSha !== null
        ? (selectedCommitSubject ?? "Commit")
        : selectedGitScopeLabel
      : selectedTurn?.runId === latestTurn?.runId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionTitle = toolCallSelection
    ? "Tool call"
    : selectedTurn
      ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
      : selectedGitScopeLabel;
  const headerCommitSha = selectedRunId === null ? selectedCommitSha : null;
  const selectedCommitUrl =
    headerCommitSha !== null
      ? projectCommitUrl(activeProject?.repositoryIdentity, headerCommitSha)
      : null;
  const openLink = useOpenLink(routeThreadRef);
  // A SHA link goes to the code host; it must not route back into this pane's commit selection.
  const openCommitUrl = (event: MouseEvent<HTMLElement>, url: string) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1)
      return;
    event.preventDefault();
    void openLink(url, { event });
  };

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshBranchDiffPreview,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}:${activeCwd ?? ""}`,
  });

  // The turn scope still ships one checkpoint patch, so its tree is parsed from that patch.
  const checkpointRenderablePatch = useMemo(
    () =>
      toolCallSelection
        ? getRenderablePatch(
            toolCallPreview?.patch,
            `tool-diff:${toolCallSelection.itemId}:${resolvedTheme}`,
            { ignoreWhitespace: diffIgnoreWhitespace },
          )
        : selectedTurn
          ? getRenderablePatch(activeCheckpointDiff.data?.diff, `diff-checkpoint:${resolvedTheme}`)
          : null,
    [
      activeCheckpointDiff.data?.diff,
      resolvedTheme,
      selectedTurn,
      toolCallSelection,
      toolCallPreview?.patch,
      diffIgnoreWhitespace,
    ],
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const allDiffTreeFiles = useMemo<DiffTreeFile[]>(() => {
    const byPath = (left: DiffTreeFile, right: DiffTreeFile) =>
      left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
    if (isRecordedSelection) {
      if (checkpointRenderablePatch?.kind !== "files") return [];
      return checkpointRenderablePatch.files
        .map((fileDiff) => ({
          path: resolveFileDiffPath(fileDiff),
          ...getDiffLineStat([fileDiff]),
        }))
        .toSorted(byPath);
    }
    return (selectedGitSource?.files ?? [])
      .map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))
      .toSorted(byPath);
  }, [checkpointRenderablePatch, selectedGitSource?.files, isRecordedSelection]);
  const isFileShown = useCallback(
    (path: string) => !hideTestFiles || path === selectedFilePath || !isTestChangedFile(path),
    [hideTestFiles, selectedFilePath],
  );
  const diffTreeFiles = useMemo(
    () => allDiffTreeFiles.filter((file) => isFileShown(file.path)),
    [allDiffTreeFiles, isFileShown],
  );
  const testFileCount = allDiffTreeFiles.filter((file) => isTestChangedFile(file.path)).length;
  const resolvedTreeFilePath =
    diffTreeFiles.find((file) => file.path === treeSelectedFilePath)?.path ??
    diffTreeFiles.find((file) => file.path === selectedFilePath)?.path ??
    diffTreeFiles[0]?.path ??
    null;
  const resolvedTreeFilePreviousPath =
    selectedGitSource?.files?.find((file) => file.path === resolvedTreeFilePath)?.previousPath ??
    null;
  // With the tree hidden the panel stacks every file and loads their patches progressively.
  // Everything else loads exactly the file on screen.
  const showStackedPatch = !isRecordedSelection && !filesTreeOpen && diffTreeFiles.length > 1;
  const gitPatchCwd = branchDiffPreview.data?.cwd ?? null;
  const selectedFileDiffPreview = useEnvironmentQuery(
    !isRecordedSelection && activeThread && gitPatchCwd && !showStackedPatch && resolvedTreeFilePath
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: gitPatchCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ...(selectedCommitSha ? { commitSha: selectedCommitSha } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
            file: {
              path: resolvedTreeFilePath,
              previousPath: resolvedTreeFilePreviousPath,
              sourceKind: activeSourceKind,
            },
          },
        })
      : null,
  );
  const activeGitPatchSource = showStackedPatch
    ? selectedGitSource
    : selectedFileDiffPreview.data?.sources.find((source) => source.kind === activeSourceKind);
  const refreshSelectedFilePatch = selectedFileDiffPreview.refresh;
  // Refreshing has to move both queries: the file list and the patch on screen come from separate
  // requests, so refreshing one alone leaves the other showing the previous state.
  const refreshDiff = useCallback(() => {
    refreshBranchDiffPreview();
    refreshSelectedFilePatch();
  }, [refreshBranchDiffPreview, refreshSelectedFilePatch]);
  useProjectEntriesWatchRefresh(
    canRefreshGitDiff ? (activeThread?.environmentId ?? null) : null,
    canRefreshGitDiff ? activeCwd : null,
    refreshDiff,
  );
  refreshDiffRef.current = refreshDiff;

  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (
      selectedRunId !== null ||
      !activeThread ||
      !preview ||
      !selectedGitSource ||
      !gitPatchCwd ||
      !activeGitPatchSource
    ) {
      return undefined;
    }

    if (!canReadFiles) return undefined;
    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: gitPatchCwd,
      sourceKind: activeGitPatchSource.kind,
      baseRef: activeGitPatchSource.baseRef,
      headRef: activeGitPatchSource.headRef,
      cacheKey: activeGitPatchSource.diffHash,
    });
  }, [
    activeThread,
    branchDiffPreview.data,
    getDiffFileContents,
    canReadFiles,
    selectedGitSource,
    selectedRunId,
    gitPatchCwd,
    activeGitPatchSource,
  ]);
  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);
  const canSelectBranchBase = canReadFiles && canRefreshGitDiff && selectedGitScope === "branch";
  const branchRefsCwd = branchDiffPreview.data?.cwd ?? activeCwd;
  const localBranchRefs = useEnvironmentQuery(
    canSelectBranchBase && activeThread && branchRefsCwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchRefsCwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    canSelectBranchBase && activeThread && branchRefsCwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchRefsCwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== comparisonHeadRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const selectedPatch = toolCallSelection
    ? toolCallPreview?.patch
    : selectedTurn
      ? activeCheckpointDiff.data?.diff
      : activeGitPatchSource?.diff;
  const isSelectedPatchTruncated =
    toolCallPreview?.truncated === true ||
    (!isRecordedSelection && activeGitPatchSource?.truncated === true);
  const selectedPatchQuery = toolCallSelection
    ? toolCallDetail
    : selectedTurn
      ? activeCheckpointDiff
      : filesTreeOpen
        ? selectedFileDiffPreview
        : branchDiffPreview;
  const isLoadingSelectedPatch = selectedPatchQuery.isPending && selectedPatchQuery.data === null;
  const selectedPatchError = toolCallSelection
    ? toolCallDetail.error
    : selectedTurn
      ? activeCheckpointDiff.error
      : (branchDiffPreview.error ?? selectedFileDiffPreview.error);
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = isRecordedSelection
    ? hasResolvedPatch && selectedPatch.trim().length === 0
    : branchDiffPreview.data !== null && diffTreeFiles.length === 0;
  const lazySource = showStackedPatch ? (selectedGitSource ?? null) : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
            compactPartialHunkOffsets: isGitSelection,
            ...(toolCallSelection ? { ignoreWhitespace: diffIgnoreWhitespace } : {}),
          }),
    [
      lazySource,
      resolvedTheme,
      selectedPatch,
      isGitSelection,
      toolCallSelection,
      diffIgnoreWhitespace,
    ],
  );
  const fileStats = useMemo(
    () => new Map(lazySource?.files?.map((file) => [file.path, file])),
    [lazySource?.files],
  );
  const {
    scope: filePatchScope,
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    baseRef:
      selectedCommitSha !== null ? selectedBaseRef : (lazySource?.baseRef ?? selectedBaseRef),
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    previewInput: branchDiffPreviewInput,
    preview: renderablePatch,
  });
  const revalidateOnOpen = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Revalidate cached patches when the external panel becomes visible.
  useEffect(() => {
    if (!visible || !canRefreshGitDiff) {
      revalidateOnOpen.current = false;
      return;
    }
    if (revalidateOnOpen.current) return;
    revalidateOnOpen.current = true;
    if (branchDiffPreview.data !== null && !branchDiffPreview.isPending) refreshDiffRef.current();
  }, [visible, canRefreshGitDiff, branchDiffPreview.data, branchDiffPreview.isPending]);

  const isRefreshingDiff =
    branchDiffPreview.isPending || areFilePatchesPending || selectedFileDiffPreview.isPending;
  const renderableFileEntries = useMemo(
    () =>
      renderableFiles
        .filter((file) => isFileShown(resolveFileDiffPath(file)))
        .map(getCachedFileEntry),
    [renderableFiles, isFileShown],
  );
  const defaultCollapsedDiffFileKeys = useMemo(
    () =>
      settings.diffFilesCollapsed
        ? new Set(renderableFileEntries.map((file) => file.fileKey))
        : EMPTY_COLLAPSED_DIFF_FILE_KEYS,
    [renderableFileEntries, settings.diffFilesCollapsed],
  );
  const storedCollapsedDiffFileKeys = useDiffPanelSessionStore((state) =>
    collapseScopeKey ? state.collapsedFileKeysByScopeKey[collapseScopeKey] : undefined,
  );
  const collapsedDiffFileKeys = storedCollapsedDiffFileKeys ?? defaultCollapsedDiffFileKeys;
  const setCollapsedDiffFiles = useCallback(
    (
      update: (current: { scopeKey: string | null; fileKeys: ReadonlySet<string> }) => {
        scopeKey: string | null;
        fileKeys: ReadonlySet<string>;
      },
    ) => {
      if (!collapseScopeKey) return;
      useDiffPanelSessionStore
        .getState()
        .updateCollapsedFileKeys(
          collapseScopeKey,
          defaultCollapsedDiffFileKeys,
          (current) => update({ scopeKey: collapseScopeKey, fileKeys: current }).fileKeys,
        );
    },
    [collapseScopeKey, defaultCollapsedDiffFileKeys],
  );
  const renderLoadingBoundary = useCallback(
    () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null,
    [settledFileCount, renderableFiles.length, loadNextFiles],
  );
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries
        .filter(({ fileDiff }) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)))
        .map(({ fileDiff, fileKey, fileVersion }) => {
          return {
            fileDiff,
            filePath: resolveFileDiffPath(fileDiff),
            fileKey,
            fileVersion,
            collapsed:
              collapsedDiffFileKeys.has(fileKey) ||
              fileDiff.cacheKey?.endsWith(":pending") === true,
          };
        }),
    [collapsedDiffFileKeys, renderableFileEntries, lazySource, readyFilePaths],
  );
  const diffFileKeys = useMemo(
    () => renderableFileEntries.map((file) => file.fileKey),
    [renderableFileEntries],
  );
  // The git scopes already loaded exactly what is on screen; only a checkpoint patch, which always
  // arrives whole, still has to be narrowed to the selected file here.
  const visibleCodeViewFiles =
    isRecordedSelection && filesTreeOpen && codeViewFiles.length > 1 && resolvedTreeFilePath
      ? codeViewFiles.filter((file) => file.filePath === resolvedTreeFilePath)
      : codeViewFiles;
  const [treeSelectionScope, setTreeSelectionScope] = useState(collapseScopeKey);
  if (treeSelectionScope !== collapseScopeKey) {
    setTreeSelectionScope(collapseScopeKey);
    setTreeSelectedFilePath(null);
  }
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(
    () =>
      allDiffTreeFiles.reduce(
        (total, file) => ({
          additions: total.additions + (file.additions ?? 0),
          deletions: total.deletions + (file.deletions ?? 0),
        }),
        { additions: 0, deletions: 0 },
      ),
    [allDiffTreeFiles],
  );
  const selectedDiffFileKey = resolvedTreeFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === resolvedTreeFilePath)?.fileKey ??
      null)
    : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reveal the chosen file in the imperative diff viewer.
  useEffect(() => {
    if (!selectedDiffFileKey || !codeView?.getInstance()) return;
    setCollapsedDiffFiles((current) => {
      if (!current.fileKeys.has(selectedDiffFileKey)) return current;
      const next = new Set(current.fileKeys);
      next.delete(selectedDiffFileKey);
      return { scopeKey: collapseScopeKey, fileKeys: next };
    });
    codeView.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [
    codeView,
    codeViewMountKey,
    selectedDiffFileKey,
    selectedFileRevealRequestId,
    setCollapsedDiffFiles,
    collapseScopeKey,
  ]);

  const requestTreeReveal = useCodeViewFileReveal();
  const attachCodeView = useCallback(
    (viewer: AnnotatableCodeViewHandle | null) => {
      setCodeView(viewer);
      requestTreeReveal.attach(viewer);
    },
    [requestTreeReveal],
  );
  const revealDiffFile = useCallback(
    (filePath: string) => {
      const index = renderableFileEntries.findIndex(
        (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
      );
      const file = renderableFileEntries[index];
      if (!file) return;
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        next.delete(file.fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
      if (lazySource && index >= settledFileCount) {
        requestFile(index);
      }
      requestTreeReveal.request(file.fileKey);
    },
    [
      renderableFileEntries,
      collapseScopeKey,
      defaultCollapsedDiffFileKeys,
      setCollapsedDiffFiles,
      requestTreeReveal,
      lazySource,
      settledFileCount,
      requestFile,
    ],
  );

  const externalRevealRef = useRef<{ cache: string; key: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Consume external file-reveal requests after lazy patch loading.
  useEffect(() => {
    if (!lazySource || !selectedFilePath) return;
    const key = `${selectedFilePath}:${selectedFileRevealRequestId}`;
    if (
      externalRevealRef.current?.cache === filePatchScope &&
      externalRevealRef.current.key === key
    )
      return;
    externalRevealRef.current = { cache: filePatchScope, key };
    revealDiffFile(selectedFilePath);
  }, [lazySource, selectedFilePath, selectedFileRevealRequestId, filePatchScope, revealDiffFile]);

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, activeRepositoryRoot, openInPreferredEditor, routeThreadRef],
  );
  const collapseDefaultsRef = useRef({
    collapseScopeKey,
    defaultCollapsedDiffFileKeys,
    setCollapsedDiffFiles,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Update event-time collapse defaults after the committed viewer selection.
  useLayoutEffect(() => {
    collapseDefaultsRef.current = {
      collapseScopeKey,
      defaultCollapsedDiffFileKeys,
      setCollapsedDiffFiles,
    };
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys, setCollapsedDiffFiles]);
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    const { collapseScopeKey, defaultCollapsedDiffFileKeys, setCollapsedDiffFiles } =
      collapseDefaultsRef.current;
    setCollapsedDiffFiles((current) => {
      const next = new Set(
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
      );
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return { scopeKey: collapseScopeKey, fileKeys: next };
    });
  }, []);
  const selectDiffFileFromTree = useCallback(
    (filePath: string) => {
      if (!diffTreeFiles.some((candidate) => candidate.path === filePath)) return;
      revealDiffFile(filePath);
      setTreeSelectedFilePath(filePath);
    },
    [diffTreeFiles, revealDiffFile],
  );
  // Find can ask again before the unfolded file reaches the viewer, so this must never fold.
  const unfoldDiffFile = useCallback((fileKey: string) => {
    const { collapseScopeKey, defaultCollapsedDiffFileKeys, setCollapsedDiffFiles } =
      collapseDefaultsRef.current;
    setCollapsedDiffFiles((current) => {
      const fileKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys;
      if (!fileKeys.has(fileKey)) return current;
      const next = new Set(fileKeys);
      next.delete(fileKey);
      return { scopeKey: collapseScopeKey, fileKeys: next };
    });
  }, []);

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys, diffFileKeys, setCollapsedDiffFiles]);

  const selectTurn = (runId: RunId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, runId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };
  const selectedTurnValue = selectedTurn ? `turn:${selectedTurn.runId}` : "";
  const selectedCommitValue = selectedCommitSha !== null ? `commit:${selectedCommitSha}` : "";
  const selectedScopeValue = toolCallSelection
    ? ""
    : selectedRunId === null
      ? selectedCommitValue || selectedGitScope
      : selectedTurn?.runId === latestTurn?.runId
        ? "latest"
        : selectedTurnValue;
  const selectScopeValue = (value: string) => {
    if (value === "unstaged" || value === "branch") {
      selectGitScope(value);
    } else if (value === selectedCommitValue) {
      selectGitScope("branch");
    } else if (value.startsWith("commit:")) {
      if (routeThreadRef) {
        useDiffPanelStore.getState().selectCommit(routeThreadRef, value.slice("commit:".length));
      }
    } else if (value === "latest") {
      if (latestTurn) selectTurn(latestTurn.runId);
    } else {
      const turn = orderedTurnDiffSummaries.find((summary) => `turn:${summary.runId}` === value);
      if (turn) selectTurn(turn.runId);
    }
  };

  const diffCodeView = (
    <AnnotatableCodeView
      key={`${collapseScopeKey ?? reviewSectionId}:${resolvedTreeFilePath ?? "all"}`}
      viewerRef={attachCodeView}
      codeViewKey={`${codeViewMountKey}:${lazySource ? filePatchScope : (resolvedTreeFilePath ?? "all")}`}
      className="h-full min-h-0 overflow-auto"
      onRevealSearchMatch={unfoldDiffFile}
      files={visibleCodeViewFiles}
      pendingFiles={renderableFiles.filter(
        (file) => file.cacheKey?.endsWith(":pending") && isFileShown(resolveFileDiffPath(file)),
      )}
      renderCodeViewFooter={renderLoadingBoundary}
      sectionId={reviewSectionId}
      sectionTitle={reviewSectionTitle}
      composerDraftTarget={composerDraftTarget}
      renderHeaderFilenameSuffix={(fileDiff) => {
        const path = resolveFileDiffPath(fileDiff);
        const state = fileStates.get(path);
        return (
          <DiffFileHeaderSuffix
            filePath={path}
            hasStat={fileStats.has(path)}
            error={state?.error ?? false}
            truncated={state?.truncated ?? false}
            onRetry={retry}
          />
        );
      }}
      {...(lazySource
        ? {
            unsafeCSSExtra: "[data-additions-count], [data-deletions-count] { display: none; }",
            renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
              const stat = fileStats.get(resolveFileDiffPath(fileDiff));
              return stat ? (
                <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
              ) : null;
            },
          }
        : {})}
      renderHeaderPrefix={(fileDiff, fileKey, viewerCollapsed) => {
        const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
        return (
          <DiffFileCollapseToggle
            filePath={resolveFileDiffPath(fileDiff)}
            fileKey={fileKey}
            collapsed={unavailable || viewerCollapsed}
            unavailable={unavailable}
            onToggle={toggleDiffFileCollapsed}
          />
        );
      }}
      options={{
        onPostRender: requestTreeReveal.flush,
        diffStyle: diffLayout === "split" ? "split" : "unified",
        lineDiffType: "none",
        overflow: wordWrap ? "wrap" : "scroll",
        theme: resolveDiffThemeName(resolvedTheme),
        themeType: resolvedTheme as DiffThemeType,
        stickyHeaders: true,
        loadDiffFiles,
      }}
    />
  );
  // The tree renders from the file list, so a failed or empty patch only empties this column.
  const diffCodeColumn = (
    <div className="min-h-0 min-w-0 flex-1">
      {!renderablePatch && toolCallPreview && toolCallPreview.content.length > 0 ? (
        <div className="h-full space-y-3 overflow-auto p-3 text-xs">
          <p className="text-muted-foreground">
            The provider recorded file content without a diff.
          </p>
          {toolCallPreview.content.map(({ label, text }) => (
            <div key={label} className="space-y-1">
              <p className="text-muted-foreground">{label}</p>
              <pre
                className={cn(
                  "overflow-auto font-mono text-2xs",
                  wordWrap && "whitespace-pre-wrap wrap-break-word",
                )}
              >
                {text}
              </pre>
            </div>
          ))}
        </div>
      ) : !renderablePatch && !lazySource ? (
        isLoadingSelectedPatch ? (
          <DiffPanelLoadingState
            label={
              selectedTurn
                ? "Loading checkpoint diff..."
                : selectedGitScope === "unstaged"
                  ? "Loading uncommitted changes..."
                  : "Loading changes..."
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>
              {hasNoNetChanges
                ? "No net changes in this selection."
                : "No patch available for this selection."}
            </p>
          </div>
        )
      ) : lazySource || renderablePatch?.kind === "files" ? (
        diffCodeView
      ) : (
        <div className="h-full min-h-0 overflow-auto p-2">
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground/75">
              {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
            </p>
            <pre
              className={cn(
                "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                wordWrap ? "overflow-auto whitespace-pre-wrap wrap-break-word" : "overflow-auto",
              )}
            >
              {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
            </pre>
          </div>
        </div>
      )}
    </div>
  );

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        {isGitSelection && diffRoots.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-6 min-w-0 max-w-44 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={`Diff directory: ${activeCwd ?? "unknown"}`}
              title={activeCwd}
            >
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <span className="truncate">
                {selectedDiffRoot
                  ? workspaceDisplayName(selectedDiffRoot, selectedDiffRootIndex)
                  : "Directory"}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
              {diffRoots.map((root, index) => (
                <DropdownMenuItem
                  key={root.path}
                  className={root.path === activeCwd ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setSelectedWorkspaceRoot(index === 0 ? null : root.path)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      {workspaceDisplayName(root, index)}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">{root.path}</div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            className={cn("max-w-full", headerCommitSha !== null && "min-w-0 shrink")}
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          {headerCommitSha !== null ? (
            selectedCommitUrl ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      href={selectedCommitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 font-mono text-xs text-muted-foreground underline underline-offset-4"
                      onClick={(event) => openCommitUrl(event, selectedCommitUrl)}
                    />
                  }
                >
                  {headerCommitSha.slice(0, 7)}
                </TooltipTrigger>
                <TooltipPopup side="top">{selectedCommitUrl}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {headerCommitSha.slice(0, 7)}
              </span>
            )
          ) : null}
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
              <DropdownMenuRadioItem value="branch" closeOnClick>
                <span>Changes</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unstaged" closeOnClick>
                <span>Uncommitted</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="latest" closeOnClick>
                <span>Latest turn</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={selectedTurnValue} onValueChange={selectScopeValue}>
                  {orderedTurnDiffSummaries.map((summary) => {
                    const turnCount = summary.checkpointTurnCount;
                    return (
                      <DropdownMenuRadioItem
                        key={summary.runId}
                        value={`turn:${summary.runId}`}
                        closeOnClick
                      >
                        <span className="flex items-center gap-2">
                          <span>Turn {turnCount}</span>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub
              onOpenChange={(open) => {
                setOpenCommitMenu(open ? (branchCommitsQuery.data ?? null) : null);
                if (!open) return;
                // The menu keeps the list it opened with; the refreshed one shows next time.
                branchCommitsQuery.refresh();
              }}
            >
              <DropdownMenuSubTrigger>Commits</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 max-w-96">
                <DropdownMenuRadioGroup
                  value={selectedCommitValue}
                  onValueChange={selectScopeValue}
                >
                  {branchCommits?.commits.map((commit) => {
                    const commitUrl = projectCommitUrl(
                      activeProject?.repositoryIdentity,
                      commit.sha,
                    );
                    return (
                      <div
                        key={commit.sha}
                        className={cn(
                          "flex items-center rounded-sm hover:bg-accent has-data-highlighted:bg-accent has-focus-visible:bg-accent [&_[data-checked]]:bg-transparent [&_[data-highlighted]]:bg-transparent",
                          selectedCommitSha === commit.sha && "bg-foreground/[0.08]",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <DropdownMenuRadioItem
                                className="min-w-0 flex-1"
                                value={`commit:${commit.sha}`}
                                closeOnClick
                              />
                            }
                          >
                            <span className="flex items-center gap-3">
                              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {formatRelativeTimeLabel(commit.committedAt)}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipPopup side="right" className="max-w-80">
                            {commit.subject}
                          </TooltipPopup>
                        </Tooltip>
                        {commitUrl ? (
                          <DropdownMenuItem
                            className="shrink-0"
                            render={
                              <a
                                href={commitUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open commit ${commit.sha.slice(0, 7)}`}
                              />
                            }
                            onClick={(event) => openCommitUrl(event, commitUrl)}
                          >
                            <span className="font-mono text-xs text-muted-foreground underline underline-offset-4">
                              {commit.sha.slice(0, 7)}
                            </span>
                          </DropdownMenuItem>
                        ) : (
                          <span className="shrink-0 px-2 font-mono text-xs text-muted-foreground">
                            {commit.sha.slice(0, 7)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </DropdownMenuRadioGroup>
                {branchCommitsQuery.error ? (
                  <DropdownMenuItem disabled>{branchCommitsQuery.error}</DropdownMenuItem>
                ) : !canReadFiles ? (
                  <DropdownMenuItem disabled>
                    {fileAccess.isPending
                      ? "Checking file access..."
                      : (fileAccess.error ?? "This connection cannot read local diffs.")}
                  </DropdownMenuItem>
                ) : branchCommits === null ? (
                  <DropdownMenuItem disabled>Loading commits...</DropdownMenuItem>
                ) : branchCommits.commits.length === 0 ? (
                  <DropdownMenuItem disabled>No commits on this branch.</DropdownMenuItem>
                ) : branchCommits.truncated ? (
                  <DropdownMenuItem disabled>
                    {`Showing latest ${branchCommits.commits.length} commits`}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {canSelectBranchBase && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${comparisonHeadRef} against ${comparisonBaseRef}`}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  // Too narrow for both refs, the New design keeps the target readable and drops
                  // the head, which is the thread's own branch.
                  <span className="flex min-w-[min(3rem,calc(100%-2.75rem))] items-center gap-2 overflow-hidden @max-[20rem]/diff-refs:hidden" />
                }
              >
                <span className="min-w-0 max-w-48 truncate">{comparisonHeadRef}</span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${comparisonHeadRef} → ${comparisonBaseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<span aria-hidden className="hidden @max-[20rem]/diff-refs:inline" />}
              >
                vs
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${comparisonHeadRef} → ${comparisonBaseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                render={<Button variant="ghost-muted" size="xs" />}
                className="min-w-9 max-w-48 shrink-0"
                aria-label={`Change comparison target. Currently ${comparisonBaseRef}`}
              >
                <span className="min-w-0 truncate">{comparisonBaseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
              >
                <ComboboxSearchInput
                  placeholder="Search refs..."
                  value={baseRefQuery}
                  onChange={(event) => setBaseRefQuery(event.target.value)}
                />
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon
                                      role="img"
                                      aria-label="Remote only"
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">Remote only</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]",
          headerCommitSha !== null && "gap-0",
        )}
      >
        {codeViewFiles.length > 0 || diffTreeFiles.length > 0 ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshDiff}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {testFileCount > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Hide test files"
                  variant="ghost"
                  size="sm"
                  pressed={hideTestFiles}
                  onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
                />
              }
            >
              <FlaskConicalOffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {hideTestFiles ? `Show ${testFileCount} hidden test files` : "Hide test files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDiffFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {diffTreeFiles.length > 1 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={filesTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={filesTreeOpen}
                  onPressedChange={(pressed) => setFilesTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {filesTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo && !toolCallSelection ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error/80">{selectedPatchError}</p>
              </div>
            )}
            <div
              className="flex min-h-0 flex-1"
              onClickCapture={(event) => {
                const composedPath = event.nativeEvent.composedPath?.() ?? [];
                for (const node of composedPath) {
                  if (!(node instanceof HTMLElement)) continue;
                  // Header buttons own their clicks; bubbling a chevron click would toggle twice.
                  if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                    return;
                  }
                }
                const title = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-title"),
                );
                const filePath = title?.textContent?.trim();
                // The filename remains the explicit "open in editor" affordance.
                if (filePath) {
                  openDiffFile(filePath);
                  return;
                }
                const header = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                );
                const headerFilePath = header?.querySelector("[data-title]")?.textContent?.trim();
                if (!headerFilePath) return;
                const file = codeViewFiles.find(
                  (candidate) => candidate.filePath === headerFilePath,
                );
                if (file) toggleDiffFileCollapsed(file.fileKey);
              }}
              onContextMenuCapture={(event) => {
                const composedPath = event.nativeEvent.composedPath?.() ?? [];
                const title = composedPath.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-title"),
                );
                const filePath = title?.textContent?.trim();
                if (!filePath) return;
                event.preventDefault();
                onFileContextMenu(
                  {
                    environmentId: activeThread?.environmentId ?? null,
                    filePath,
                    workspaceRoot: activeCwd,
                    repositoryRoot: activeRepositoryRoot,
                  },
                  event,
                );
              }}
            >
              {filesTreeOpen && diffTreeFiles.length > 1 ? (
                <ResizableColumns
                  storageKey="t3code.diffFilesTreeRatio"
                  defaultRatio={0.3}
                  firstMinPx={150}
                  secondMinPx={260}
                  className="min-h-0 flex-1"
                  separatorLabel="Resize changed files tree"
                  first={
                    <DiffFilesTreeNavigator
                      files={diffTreeFiles}
                      resolvedTheme={resolvedTheme}
                      selectedPath={resolvedTreeFilePath}
                      onSelectFile={selectDiffFileFromTree}
                      onClose={() => setFilesTreeOpen(false)}
                    />
                  }
                  second={diffCodeColumn}
                />
              ) : (
                diffCodeColumn
              )}
            </div>
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
