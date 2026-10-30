import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type GitChangeKind,
  type GitFileChange,
  type ModelSelection,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@d4research/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import { createModelSelection } from "@d4research/shared/model";
import {
  Check,
  PanelLeft,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { cn, newMessageId } from "~/lib/utils";

import {
  commitGitStaged,
  discardGitChanges,
  generateGitCommitMessage,
  resolveGitConflict,
  stageGitFiles,
  unstageGitFiles,
  useGitDetailedStatus,
} from "./gitChangesState";
import { useProjectEntriesWatchRefresh } from "./projectFilesQueryState";

interface GitChangesPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef: ScopedThreadRef;
  selectedPath?: string | null;
  onShowDiff: (relativePath: string) => void;
  workspaceMutationId: string | null;
}

interface StatusBadge {
  readonly letter: string;
  readonly color: string;
  readonly label: string;
}

// Pale red used to mark unversioned (untracked) files in both the Commit panel and the file tree.
const UNVERSIONED_COLOR = "#e0828c";
const CONFLICT_MODEL_STORAGE_KEY = "t3code.gitConflictModelSelection";
const REMEMBER_CONFLICT_MODEL_STORAGE_KEY = "t3code.rememberGitConflictModel";

function readRememberedConflictModel(): ModelSelection | null {
  try {
    const raw = window.localStorage.getItem(CONFLICT_MODEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelSelection>;
    if (typeof parsed.instanceId !== "string" || typeof parsed.model !== "string") return null;
    return createModelSelection(
      parsed.instanceId as ProviderInstanceId,
      parsed.model,
      Array.isArray(parsed.options) ? parsed.options : undefined,
    );
  } catch {
    return null;
  }
}

function readRememberConflictModel(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_CONFLICT_MODEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeRememberedConflictModel(selection: ModelSelection | null): void {
  try {
    if (selection) {
      window.localStorage.setItem(CONFLICT_MODEL_STORAGE_KEY, JSON.stringify(selection));
    } else {
      window.localStorage.removeItem(CONFLICT_MODEL_STORAGE_KEY);
    }
  } catch {
    // Storage is optional; the active in-memory selection still works.
  }
}

const STATUS_BADGE_BY_KIND: Readonly<Record<GitChangeKind, StatusBadge>> = {
  modified: { letter: "M", color: "#4c9ffe", label: "Modified" },
  added: { letter: "A", color: "#3fb950", label: "Added" },
  deleted: { letter: "D", color: "#f85149", label: "Deleted" },
  renamed: { letter: "R", color: "#d29922", label: "Renamed" },
  copied: { letter: "C", color: "#d29922", label: "Copied" },
  typechange: { letter: "T", color: "#d29922", label: "Type changed" },
  unmerged: { letter: "U", color: "#f85149", label: "Unmerged" },
  untracked: { letter: "?", color: UNVERSIONED_COLOR, label: "Unversioned" },
};

function badgeForFile(file: GitFileChange): StatusBadge {
  const kind = file.untracked
    ? "untracked"
    : (file.indexStatus ?? file.worktreeStatus ?? "modified");
  return STATUS_BADGE_BY_KIND[kind];
}

function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf("/");
  return slash >= 0
    ? { name: path.slice(slash + 1), directory: path.slice(0, slash) }
    : { name: path, directory: "" };
}

function GitChangeRow({
  file,
  busy,
  selected,
  onToggleStage,
  onDiscard,
  onResolveConflict,
  onOpen,
}: {
  file: GitFileChange;
  busy: boolean;
  selected: boolean;
  onToggleStage: (file: GitFileChange) => void;
  onDiscard: (file: GitFileChange) => void;
  onResolveConflict: (file: GitFileChange, resolution: "ours" | "theirs" | "mark_resolved") => void;
  onOpen: (file: GitFileChange) => void;
}) {
  const fullyStaged = file.staged && !file.unstaged;
  const partiallyStaged = file.staged && file.unstaged;
  const badge = badgeForFile(file);
  const { name, directory } = splitPath(file.path);
  const renameFrom = file.origPath ? splitPath(file.origPath).name : null;

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/60",
        selected && "bg-accent/80",
      )}
    >
      <input
        type="checkbox"
        className="size-3.5 shrink-0 cursor-pointer accent-[#4c9ffe]"
        checked={fullyStaged}
        ref={(element) => {
          if (element) element.indeterminate = partiallyStaged;
        }}
        disabled={busy}
        aria-label={file.staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
        onChange={() => onToggleStage(file)}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold"
              style={{ color: badge.color }}
              aria-hidden="true"
            />
          }
        >
          {badge.letter}
        </TooltipTrigger>
        <TooltipPopup>{badge.label}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        onClick={() => onOpen(file)}
      >
        <span
          className={cn("truncate text-xs", !file.untracked && "text-foreground")}
          style={file.untracked ? { color: UNVERSIONED_COLOR } : undefined}
        >
          {name}
        </span>
        {renameFrom && renameFrom !== name ? (
          <span className="shrink-0 truncate text-[10px] text-muted-foreground">
            ← {renameFrom}
          </span>
        ) : null}
        {directory ? (
          <span className="truncate text-[10px] text-muted-foreground">{directory}</span>
        ) : null}
      </button>
      {badge.letter === "U" ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  disabled={busy}
                  aria-label={`Use current branch version of ${file.path}`}

                  onClick={() => onResolveConflict(file, "ours")}
                />
              }
            >
              <PanelLeft className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>{"Use ours"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  disabled={busy}
                  aria-label={`Use incoming branch version of ${file.path}`}

                  onClick={() => onResolveConflict(file, "theirs")}
                />
              }
            >
              <PanelRight className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>{"Use theirs"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  disabled={busy}
                  aria-label={`Mark ${file.path} resolved`}

                  onClick={() => onResolveConflict(file, "mark_resolved")}
                />
              }
            >
              <Check className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>{"Mark edited file resolved"}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              disabled={busy}
              aria-label={`Discard changes to ${file.path}`}

              onClick={() => onDiscard(file)}
            />
          }
        >
          <RotateCcw className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>{"Discard changes"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function GitChangeGroup({
  title,
  files,
  busy,
  allStaged,
  separated,
  selectedPath,
  onToggleAll,
  onToggleStage,
  onDiscard,
  onResolveConflict,
  onOpen,
}: {
  title: string;
  files: ReadonlyArray<GitFileChange>;
  busy: boolean;
  allStaged: boolean;
  separated?: boolean;
  selectedPath?: string | null;
  onToggleAll: (files: ReadonlyArray<GitFileChange>, stage: boolean) => void;
  onToggleStage: (file: GitFileChange) => void;
  onDiscard: (file: GitFileChange) => void;
  onResolveConflict: (file: GitFileChange, resolution: "ours" | "theirs" | "mark_resolved") => void;
  onOpen: (file: GitFileChange) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-col", separated && "mt-1.5 border-t border-border/60 pt-1.5")}>
      <div className="flex items-center gap-2 px-2 py-1">
        <input
          type="checkbox"
          className="size-3.5 shrink-0 cursor-pointer accent-[#4c9ffe]"
          checked={allStaged}
          disabled={busy}
          aria-label={allStaged ? `Unstage all ${title}` : `Stage all ${title}`}
          onChange={() => onToggleAll(files, !allStaged)}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {title}
        </span>
        <span className="text-[10px] text-muted-foreground">{files.length}</span>
      </div>
      {files.map((file) => (
        <GitChangeRow
          key={file.path}
          file={file}
          busy={busy}
          selected={file.path === selectedPath}
          onToggleStage={onToggleStage}
          onDiscard={onDiscard}
          onResolveConflict={onResolveConflict}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

export default function GitChangesPanel({
  environmentId,
  cwd,
  threadRef,
  selectedPath,
  onShowDiff,
  workspaceMutationId,
}: GitChangesPanelProps) {
  const status = useGitDetailedStatus(environmentId, cwd);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: status.refresh,
    resourceKey: `commit-status:${environmentId}:${cwd}`,
  });
  useProjectEntriesWatchRefresh(environmentId, cwd, status.refresh);
  const clientSettings = useClientSettings();
  const activeThread = useThreadShell(threadRef);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [startingConflictResolution, setStartingConflictResolution] = useState(false);
  const [rememberConflictModel, setRememberConflictModel] = useState(readRememberConflictModel);
  const [conflictModelSelection, setConflictModelSelection] = useState<ModelSelection | null>(
    readRememberedConflictModel,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const files = status.data?.files ?? [];
  const unifiedSettings = useMemo(
    () => (serverConfig ? { ...serverConfig.settings, ...clientSettings } : null),
    [clientSettings, serverConfig],
  );
  const conflicts = useMemo(
    () =>
      files.filter((file) => file.indexStatus === "unmerged" || file.worktreeStatus === "unmerged"),
    [files],
  );
  const modelInstanceEntries = useMemo(
    () =>
      serverConfig
        ? providerInstanceEntriesFor(
            serverConfig.providers,
            unifiedSettings!,
            activeThread?.projectId ?? null,
          )
        : [],
    [serverConfig, unifiedSettings, activeThread?.projectId],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        modelInstanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(unifiedSettings!, entry),
        ]),
      ),
    [modelInstanceEntries, unifiedSettings],
  );
  const effectiveConflictModelSelection =
    conflictModelSelection ??
    activeThread?.modelSelection ??
    serverConfig?.settings.textGenerationModelSelection ??
    null;

  if (conflictModelSelection === null && effectiveConflictModelSelection !== null) {
    setConflictModelSelection(effectiveConflictModelSelection);
  }
  const { changes, unversioned } = useMemo(() => {
    const tracked: GitFileChange[] = [];
    const untracked: GitFileChange[] = [];
    for (const file of files) {
      (file.untracked ? untracked : tracked).push(file);
    }
    return { changes: tracked, unversioned: untracked };
  }, [files]);

  const stagedCount = useMemo(() => files.filter((file) => file.staged).length, [files]);
  const changesAllStaged =
    changes.length > 0 && changes.every((file) => file.staged && !file.unstaged);
  const unversionedAllStaged = unversioned.length > 0 && unversioned.every((file) => file.staged);

  const runMutation = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await operation();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Git operation failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleStage = useCallback(
    (file: GitFileChange) =>
      runMutation(() =>
        file.staged && !file.unstaged
          ? unstageGitFiles(environmentId, cwd, [file.path])
          : stageGitFiles(environmentId, cwd, [file.path]),
      ),
    [cwd, environmentId, runMutation],
  );

  const toggleAll = useCallback(
    (groupFiles: ReadonlyArray<GitFileChange>, stage: boolean) => {
      const paths = groupFiles.map((file) => file.path);
      return runMutation(() =>
        stage
          ? stageGitFiles(environmentId, cwd, paths)
          : unstageGitFiles(environmentId, cwd, paths),
      );
    },
    [cwd, environmentId, runMutation],
  );

  const discard = useCallback(
    (file: GitFileChange) => {
      const confirmation = file.untracked
        ? `Delete untracked file ${file.path}? This cannot be undone.`
        : `Discard changes to ${file.path}? This cannot be undone.`;
      if (!window.confirm(confirmation)) return;
      void runMutation(() => discardGitChanges(environmentId, cwd, [file.path]));
    },
    [cwd, environmentId, runMutation],
  );

  const resolveConflict = useCallback(
    (file: GitFileChange, resolution: "ours" | "theirs" | "mark_resolved") => {
      const confirmation =
        resolution === "mark_resolved"
          ? `Stage ${file.path} as resolved?`
          : `Replace ${file.path} with the ${resolution} version and stage it as resolved?`;
      if (!window.confirm(confirmation)) return;
      void runMutation(() => resolveGitConflict(environmentId, cwd, file.path, resolution));
    },
    [cwd, environmentId, runMutation],
  );

  const selectConflictModel = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const selection = createModelSelection(instanceId, model);
      setConflictModelSelection(selection);
      if (rememberConflictModel) writeRememberedConflictModel(selection);
    },
    [rememberConflictModel],
  );

  const toggleRememberConflictModel = useCallback(
    (checked: boolean) => {
      setRememberConflictModel(checked);
      try {
        window.localStorage.setItem(REMEMBER_CONFLICT_MODEL_STORAGE_KEY, String(checked));
      } catch {
        // Storage is optional.
      }
      writeRememberedConflictModel(checked ? effectiveConflictModelSelection : null);
    },
    [effectiveConflictModelSelection],
  );

  const resolveConflictsWithAgent = useCallback(() => {
    if (
      conflicts.length === 0 ||
      !activeThread ||
      !effectiveConflictModelSelection ||
      startingConflictResolution
    ) {
      return;
    }
    setStartingConflictResolution(true);
    setActionError(null);
    const conflictList = conflicts.map((file) => `- ${file.path}`).join("\n");
    const prompt = [
      "Resolve the current Git merge conflicts in this workspace.",
      "Inspect and resolve only these unmerged files:",
      conflictList,
      "",
      "Preserve the intended behavior from both sides, remove all conflict markers, and run relevant focused tests when practical.",
      "Stage each successfully resolved file with git add.",
      "Do not commit, push, reset, abort the merge, or discard unrelated changes.",
    ].join("\n");
    void (async () => {
      const result = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: effectiveConflictModelSelection,
          runtimeMode: activeThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: activeThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setActionError(
          error instanceof Error ? error.message : "Could not start conflict resolution.",
        );
      } else if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Conflict resolution started",
          description: `${conflicts.length.toLocaleString()} conflicted ${
            conflicts.length === 1 ? "file" : "files"
          } sent to the selected model.`,
        });
      }
      setStartingConflictResolution(false);
    })();
  }, [
    activeThread,
    conflicts,
    effectiveConflictModelSelection,
    environmentId,
    startThreadTurn,
    startingConflictResolution,
    threadRef.threadId,
  ]);

  const commit = useCallback(() => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    void runMutation(async () => {
      await commitGitStaged(environmentId, cwd, trimmed, amend);
      setMessage("");
      setAmend(false);
    });
  }, [amend, cwd, environmentId, message, runMutation]);

  const generate = useCallback(() => {
    if (busy || generating) return;
    setGenerating(true);
    setActionError(null);
    void (async () => {
      try {
        setMessage(await generateGitCommitMessage(environmentId, cwd));
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Could not generate a commit message.",
        );
      } finally {
        setGenerating(false);
      }
    })();
  }, [busy, cwd, environmentId, generating]);

  const canGenerate = !busy && !generating && stagedCount > 0;
  const canCommit =
    !busy &&
    !generating &&
    message.trim().length > 0 &&
    (stagedCount > 0 || amend) &&
    (status.data?.isRepo ?? false);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">Commit</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {status.isPending && status.data === null
              ? "Loading…"
              : `${files.length.toLocaleString()} changed · ${stagedCount.toLocaleString()} staged`}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh git status"
          onClick={status.refresh}
        >
          <RefreshCw className={cn("size-3.5", status.isPending && "animate-spin")} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {conflicts.length > 0 ? (
          <div className="border-b border-border/60 px-2 pb-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-destructive">
                {conflicts.length.toLocaleString()} merge{" "}
                {conflicts.length === 1 ? "conflict" : "conflicts"}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium",
                        activeThread && effectiveConflictModelSelection
                          ? "bg-accent text-foreground hover:bg-accent/80"
                          : "cursor-not-allowed text-muted-foreground",
                      )}
                      disabled={
                        !activeThread ||
                        !effectiveConflictModelSelection ||
                        startingConflictResolution
                      }

                      onClick={resolveConflictsWithAgent}
                    />
                  }
                >
                  {startingConflictResolution ? (
                    <RefreshCw className="size-3 animate-spin" />
                  ) : (
                    <WandSparkles className="size-3" />
                  )}
                  Resolve with AI
                </TooltipTrigger>
                <TooltipPopup>
                  {activeThread
                    ? "Ask the selected coding model to resolve and stage all conflicted files"
                    : "Start the thread before using AI conflict resolution"}
                </TooltipPopup>
              </Tooltip>
            </div>
            {effectiveConflictModelSelection && modelInstanceEntries.length > 0 ? (
              <div className="flex min-w-0 items-center gap-2">
                <ProviderModelPicker
                  environmentId={environmentId}
                  size="sm"
                  activeInstanceId={effectiveConflictModelSelection.instanceId}
                  model={effectiveConflictModelSelection.model}
                  lockedProvider={null}
                  instanceEntries={modelInstanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName="h-7 min-w-0 flex-1 border border-border/60 bg-background"
                  onInstanceModelChange={selectConflictModel}
                />
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3 accent-[#4c9ffe]"
                    checked={rememberConflictModel}
                    onChange={(event) => toggleRememberConflictModel(event.target.checked)}
                  />
                  Remember
                </label>
              </div>
            ) : null}
          </div>
        ) : null}
        {status.error && status.data === null ? (
          <div className="p-4 text-xs leading-relaxed text-destructive">{status.error}</div>
        ) : status.data && !status.data.isRepo ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            This workspace is not a Git repository.
          </div>
        ) : files.length === 0 ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            No changes. Your working tree is clean.
          </div>
        ) : (
          <>
            <GitChangeGroup
              title="Changes"
              files={changes}
              busy={busy}
              allStaged={changesAllStaged}
              selectedPath={selectedPath ?? null}
              onToggleAll={toggleAll}
              onToggleStage={toggleStage}
              onDiscard={discard}
              onResolveConflict={resolveConflict}
              onOpen={(file) => onShowDiff(file.path)}
            />
            <GitChangeGroup
              title="Unversioned"
              files={unversioned}
              busy={busy}
              allStaged={unversionedAllStaged}
              separated={changes.length > 0}
              selectedPath={selectedPath ?? null}
              onToggleAll={toggleAll}
              onToggleStage={toggleStage}
              onDiscard={discard}
              onResolveConflict={resolveConflict}
              onOpen={(file) => onShowDiff(file.path)}
            />
          </>
        )}
      </div>

      {status.data?.isRepo ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 p-2">
          {actionError ? (
            <div className="text-[11px] leading-snug text-destructive">{actionError}</div>
          ) : null}
          <textarea
            className="min-h-[6rem] max-h-[60vh] resize-y rounded border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none"
            rows={4}
            placeholder="Commit message"
            value={message}
            disabled={busy || generating}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
              <input
                type="checkbox"
                className="size-3.5 cursor-pointer accent-[#4c9ffe]"
                checked={amend}
                disabled={busy || generating}
                onChange={(event) => setAmend(event.target.checked)}
              />
              Amend last commit
            </label>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className={cn(
                        "rounded p-1.5",
                        canGenerate
                          ? "text-foreground hover:bg-accent"
                          : "cursor-not-allowed text-muted-foreground",
                      )}
                      disabled={!canGenerate}
                      aria-label="Generate commit message"

                      onClick={generate}
                    />
                  }
                >
                  {generating ? (
                    <RefreshCw className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup>{"Generate commit message"}</TooltipPopup>
              </Tooltip>
              <button
                type="button"
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium",
                  canCommit
                    ? "bg-[#4c9ffe] text-white hover:bg-[#3a8ae8]"
                    : "cursor-not-allowed bg-accent text-muted-foreground",
                )}
                disabled={!canCommit}
                onClick={commit}
              >
                {busy ? "Working…" : amend ? "Amend" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
